"""Explicit Start/End lifecycle hardening for exam sessions.

These tests exercise the orchestration path (``arm_exam_session`` /
``end_exam_session`` / ``_sync_armed_sessions``) against a fake repository, so
the lifecycle contract is proven without a database or cameras:

* a READY session never exposes subject ownership before ACTIVE is persisted
* a failed End never permanently closes an otherwise ACTIVE exam session
* reconciliation cannot disarm or re-arm a half-finished transition
* one camera is never silently stolen by another active exam session
"""

from __future__ import annotations

import threading
import time
from datetime import datetime, timedelta, timezone

import pytest

from app.domain.geometry import BBox
from app.domain.observations import FrameObservations, PersonObservation
from app.domain.session_subjects import SubjectRegistryConfig, subject_label
from app.events.subject_state_publisher import SubjectStatePublisher
from app.runtime.orchestrator import Orchestrator
from app.runtime.subject_runtime import CameraOwnershipConflict, SubjectRuntime

T0 = datetime(2026, 5, 4, 8, 0, 0, tzinfo=timezone.utc)
STARTED = datetime(2026, 5, 4, 8, 30, 0, tzinfo=timezone.utc)
ENDED = datetime(2026, 5, 4, 10, 0, 0, tzinfo=timezone.utc)
LEFT = BBox(0.10, 0.40, 0.10, 0.30)

CONFIG = SubjectRegistryConfig(
    min_frames_to_qualify=2,
    min_seconds_to_qualify=0.2,
    short_gap_seconds=2.0,
    lost_after_seconds=0.5,
    recovery_min_confidence=0.5,
    recovery_margin=0.15,
    plausible_candidate_score=0.35,
    motion_smoothing=0.3,
    pending_gap_seconds=0.5,
    max_speed_per_second=1.0,
    trajectory_length=8,
)


def at(seconds: float) -> datetime:
    return T0 + timedelta(seconds=seconds)


def frame(camera_id: str, raw_id: str, box: BBox, moment: datetime) -> FrameObservations:
    return FrameObservations(
        camera_id=camera_id,
        persons=(PersonObservation(raw_id, box, 0.9),),
        observed_at=moment,
    )


def feed(runtime: SubjectRuntime, camera_id: str, raw_id: str, box: BBox, start: float = 0.0):
    result = None
    for index in range(4):
        result = runtime.observe(frame(camera_id, raw_id, box, at(start + index * 0.2)))
    return result


class FakeRepository:
    """Just enough of the exam-session repository, with observable writes."""

    def __init__(
        self,
        sessions: dict[str, dict],
        *,
        history: dict[str, list[dict]] | None = None,
        fail_transition_to: str | None = None,
        history_fails: bool = False,
    ) -> None:
        self.sessions = sessions
        self.history = history or {}
        self.fail_transition_to = fail_transition_to
        self.history_fails = history_fails
        self.transitions: list[tuple[str, str, str]] = []

    # -- lifecycle ------------------------------------------------------
    def exam_session(self, exam_session_id: str):
        row = self.sessions.get(exam_session_id)
        return dict(row) if row else None

    def armed_exam_sessions(self) -> list[dict]:
        return [
            {"id": key, "started_at": row.get("started_at"), "camera_ids": row["camera_ids"]}
            for key, row in self.sessions.items()
            if row.get("status") == "active"
        ]

    def transition_exam_session(
        self,
        exam_session_id: str,
        *,
        expected_status: str,
        status: str,
        started_at=None,  # noqa: ANN001
        ended_at=None,  # noqa: ANN001
    ) -> bool:
        self.transitions.append((exam_session_id, expected_status, status))
        if self.fail_transition_to == status:
            raise RuntimeError("database unreachable")
        row = self.sessions.get(exam_session_id)
        if row is None or row.get("status") != expected_status:
            return False
        row["status"] = status
        if started_at is not None:
            row["started_at"] = started_at.isoformat()
        if ended_at is not None:
            row["ended_at"] = ended_at.isoformat()
        return True

    # -- subject state --------------------------------------------------
    def existing_subject_rows(self, exam_session_id: str) -> dict[int, str]:
        return {
            int(row["subject_number"]): f"row-{row['subject_number']}"
            for row in self.history.get(exam_session_id, [])
        }

    def open_subject_history(self, exam_session_id: str) -> list[dict]:
        if self.history_fails:
            raise RuntimeError("database unreachable")
        return [dict(row) for row in self.history.get(exam_session_id, [])]

    def upsert_session_subject(self, payload: dict) -> str:
        return f"row-{payload['subject_number']}"

    def open_subject_track(self, **kwargs) -> None:  # noqa: ANN003
        pass

    def close_subject_track(self, **kwargs) -> None:  # noqa: ANN003
        pass


class FakeCameraManager:
    """Only what the lifecycle needs: active cameras + per-camera lifecycle locks."""

    def __init__(self, camera_ids: tuple[str, ...]) -> None:
        self.active = {camera_id: object() for camera_id in camera_ids}
        self._locks: dict[str, threading.RLock] = {}
        self.lock_order: list[str] = []

    def lock(self, camera_id: str) -> threading.RLock:
        existing = self._locks.get(camera_id)
        if existing is None:
            existing = threading.RLock()
            self._locks[camera_id] = existing
        self.lock_order.append(camera_id)
        return existing



def build(repository: FakeRepository, cameras: tuple[str, ...] = ("cam-1",)):
    """An Orchestrator with only the lifecycle collaborators wired up."""
    publisher = SubjectStatePublisher(repository, heartbeat_seconds=5.0)
    runtime = SubjectRuntime(CONFIG, publisher)
    orchestrator = object.__new__(Orchestrator)
    orchestrator.repository = repository  # type: ignore[attr-defined]
    orchestrator.subject_publisher = publisher  # type: ignore[attr-defined]
    orchestrator.subjects = runtime  # type: ignore[attr-defined]
    orchestrator.cameras = FakeCameraManager(cameras)  # type: ignore[attr-defined]
    orchestrator._lifecycle_lock = threading.RLock()  # type: ignore[attr-defined]
    orchestrator._lifecycle_transitions = set()  # type: ignore[attr-defined]
    return orchestrator, runtime


def session_row(status: str, **extra) -> dict:
    row = {"id": "session-1", "status": status, "camera_ids": ["cam-1"]}
    row.update(extra)
    return row


def history_row(number: int, camera_id: str = "cam-1") -> dict:
    return {
        "camera_id": camera_id,
        "subject_number": number,
        "first_seen_at": T0.isoformat(),
        "last_seen_at": at(1.0).isoformat(),
        "last_bbox_x": LEFT.x,
        "last_bbox_y": LEFT.y,
        "last_bbox_width": LEFT.width,
        "last_bbox_height": LEFT.height,
        "velocity_x": 0.0,
        "velocity_y": 0.0,
        "motion_updated_at": at(1.0).isoformat(),
    }


# ============================================================ START (1-9)


def test_ready_session_with_running_camera_starts_and_arms():
    repo = FakeRepository({"session-1": session_row("ready")})
    orchestrator, runtime = build(repo)
    reply = orchestrator.arm_exam_session("session-1")
    assert reply["armed"] is True
    assert reply["cameras"] == ["cam-1"]
    assert repo.sessions["session-1"]["status"] == "active"
    assert runtime.is_armed("session-1")
    assert repo.transitions == [("session-1", "ready", "active")]


def test_start_database_failure_leaves_nothing_armed():
    repo = FakeRepository({"session-1": session_row("ready")}, fail_transition_to="active")
    orchestrator, runtime = build(repo)
    with pytest.raises(RuntimeError):
        orchestrator.arm_exam_session("session-1")
    assert repo.sessions["session-1"]["status"] == "ready"
    assert not runtime.is_armed("session-1")
    assert runtime.owner_of("cam-1") is None
    # No subject may be minted for a Start that never became ACTIVE.
    assert runtime.observe(frame("cam-1", "raw-a", LEFT, at(1.0))) is None


def test_concurrent_state_change_rejects_a_blind_start():
    repo = FakeRepository({"session-1": session_row("ready")})
    orchestrator, runtime = build(repo)
    # Another administrator moved the session back to draft meanwhile.
    original = repo.transition_exam_session

    def racing(exam_session_id, **kwargs):  # noqa: ANN001, ANN003
        repo.sessions["session-1"]["status"] = "draft"
        return original(exam_session_id, **kwargs)

    repo.transition_exam_session = racing  # type: ignore[assignment]
    with pytest.raises(RuntimeError):
        orchestrator.arm_exam_session("session-1")
    assert not runtime.is_armed("session-1")


def test_sync_cannot_disarm_a_session_during_an_explicit_start():
    repo = FakeRepository({"session-1": session_row("ready")})
    orchestrator, runtime = build(repo)
    original = repo.transition_exam_session
    observed: list[bool] = []

    def mid_transition(exam_session_id, **kwargs):  # noqa: ANN001, ANN003
        result = original(exam_session_id, **kwargs)
        # The control loop reconciles exactly between persistence and arming.
        orchestrator._sync_armed_sessions()
        observed.append(runtime.is_armed("session-1"))
        return result

    repo.transition_exam_session = mid_transition  # type: ignore[assignment]
    orchestrator.arm_exam_session("session-1")
    # Reconciliation observed the mid-transition state and did nothing to it.
    assert observed == [False]
    assert runtime.is_armed("session-1")
    assert repo.sessions["session-1"]["status"] == "active"


def test_start_retry_on_active_preserves_started_at_and_subject_state():
    repo = FakeRepository(
        {"session-1": session_row("active", started_at=STARTED.isoformat())},
        history={"session-1": [history_row(1)]},
    )
    orchestrator, runtime = build(repo)
    first = orchestrator.arm_exam_session("session-1")
    feed(runtime, "cam-1", "raw-a", LEFT)
    before = runtime.snapshots("session-1")
    second = orchestrator.arm_exam_session("session-1")
    assert first["started_at"] == second["started_at"] == STARTED.isoformat()
    assert repo.transitions == []  # no second logical start
    assert runtime.snapshots("session-1") == before
    assert [item.subject_number for item in runtime.snapshots("session-1")] == [1]


def test_active_session_needing_recovery_hydrates_s001_instead_of_starting_empty():
    repo = FakeRepository(
        {"session-1": session_row("active", started_at=STARTED.isoformat())},
        history={"session-1": [history_row(1)]},
    )
    orchestrator, runtime = build(repo)
    orchestrator.arm_exam_session("session-1")
    assert [item.subject_number for item in runtime.snapshots("session-1")] == [1]
    result = feed(runtime, "cam-1", "raw-returning", LEFT, start=1.2)
    assert result is not None
    assert dict(result.labels)["raw-returning"] == subject_label(1)
    assert [item.subject_number for item in runtime.snapshots("session-1")] == [1]


def test_active_session_with_unreadable_history_is_not_armed_empty():
    repo = FakeRepository(
        {"session-1": session_row("active", started_at=STARTED.isoformat())},
        history={"session-1": [history_row(1)]},
        history_fails=True,
    )
    orchestrator, runtime = build(repo)
    with pytest.raises(RuntimeError):
        orchestrator.arm_exam_session("session-1")
    assert not runtime.is_armed("session-1")


def test_draft_start_is_rejected():
    repo = FakeRepository({"session-1": session_row("draft")})
    orchestrator, runtime = build(repo)
    with pytest.raises(ValueError):
        orchestrator.arm_exam_session("session-1")
    assert not runtime.is_armed("session-1")
    assert repo.transitions == []


def test_ended_start_is_rejected():
    repo = FakeRepository({"session-1": session_row("ended", ended_at=ENDED.isoformat())})
    orchestrator, runtime = build(repo)
    with pytest.raises(ValueError):
        orchestrator.arm_exam_session("session-1")
    assert not runtime.is_armed("session-1")
    assert repo.transitions == []


def test_camera_owned_by_another_active_session_rejects_the_second_start():
    repo = FakeRepository(
        {
            "session-1": session_row("ready"),
            "session-2": {"id": "session-2", "status": "ready", "camera_ids": ["cam-1"]},
        }
    )
    orchestrator, runtime = build(repo)
    orchestrator.arm_exam_session("session-1")
    with pytest.raises(CameraOwnershipConflict):
        orchestrator.arm_exam_session("session-2")
    # The first session keeps its camera; the second was never started.
    assert runtime.owner_of("cam-1") == "session-1"
    assert repo.sessions["session-2"]["status"] == "ready"
    assert not runtime.is_armed("session-2")


def test_sync_with_conflicting_active_sessions_fails_closed_and_survives():
    repo = FakeRepository(
        {
            "session-1": session_row("active", started_at=STARTED.isoformat()),
            "session-2": {
                "id": "session-2",
                "status": "active",
                "camera_ids": ["cam-1"],
                "started_at": STARTED.isoformat(),
            },
        }
    )
    orchestrator, runtime = build(repo)
    orchestrator._sync_armed_sessions()  # must not raise: the loop stays alive
    armed = set(runtime.armed_session_ids)
    assert len(armed) == 1
    owner = runtime.owner_of("cam-1")
    assert owner in armed
    # A second pass must not switch camera ownership either.
    orchestrator._sync_armed_sessions()
    assert runtime.owner_of("cam-1") == owner


# ============================================================== END (10-17)


def test_active_end_stops_observations_closes_subjects_once_and_flushes():
    repo = FakeRepository({"session-1": session_row("ready")})
    orchestrator, runtime = build(repo)
    orchestrator.arm_exam_session("session-1")
    feed(runtime, "cam-1", "raw-a", LEFT)
    assert runtime.snapshots("session-1") != ()

    reply = orchestrator.end_exam_session("session-1")
    assert reply["armed"] is False
    assert reply["ended_at"]
    assert repo.sessions["session-1"]["status"] == "ended"
    assert not runtime.is_armed("session-1")
    assert runtime.owner_of("cam-1") is None
    assert orchestrator.subject_publisher.pending_depth == 0
    # Closing is idempotent: a second End does not close identities again.
    orchestrator.end_exam_session("session-1")
    assert orchestrator.subject_publisher.pending_depth == 0


def test_end_database_failure_keeps_the_session_active_and_operational():
    repo = FakeRepository({"session-1": session_row("ready")}, fail_transition_to="ended")
    orchestrator, runtime = build(repo)
    orchestrator.arm_exam_session("session-1")
    feed(runtime, "cam-1", "raw-a", LEFT)
    before = runtime.snapshots("session-1")

    with pytest.raises(RuntimeError):
        orchestrator.end_exam_session("session-1")

    assert repo.sessions["session-1"]["status"] == "active"
    assert runtime.is_armed("session-1")
    assert runtime.owner_of("cam-1") == "session-1"
    snapshots = runtime.snapshots("session-1")
    assert [item.subject_number for item in snapshots] == [
        item.subject_number for item in before
    ]
    assert all(item.is_open for item in snapshots)
    # Monitoring continues without minting a duplicate subject.
    result = feed(runtime, "cam-1", "raw-a", LEFT, start=1.0)
    assert result is not None
    assert [item.subject_number for item in runtime.snapshots("session-1")] == [1]


def test_sync_cannot_rearm_halfway_through_an_end():
    repo = FakeRepository({"session-1": session_row("ready")})
    orchestrator, runtime = build(repo)
    orchestrator.arm_exam_session("session-1")
    feed(runtime, "cam-1", "raw-a", LEFT)
    original = repo.transition_exam_session
    observed: list[str | None] = []

    def mid_transition(exam_session_id, **kwargs):  # noqa: ANN001, ANN003
        # Reconciliation runs while the row is still ACTIVE but suspended.
        orchestrator._sync_armed_sessions()
        observed.append(runtime.owner_of("cam-1"))
        return original(exam_session_id, **kwargs)

    repo.transition_exam_session = mid_transition  # type: ignore[assignment]
    orchestrator.end_exam_session("session-1")
    assert observed == [None]  # never re-armed halfway
    assert not runtime.is_armed("session-1")
    orchestrator._sync_armed_sessions()
    assert not runtime.is_armed("session-1")  # ENDED is never armed again


def test_repeated_end_preserves_the_original_ended_at():
    repo = FakeRepository({"session-1": session_row("ready")})
    orchestrator, _ = build(repo)
    orchestrator.arm_exam_session("session-1")
    first = orchestrator.end_exam_session("session-1")
    second = orchestrator.end_exam_session("session-1")
    assert first["ended_at"] == second["ended_at"]
    assert second["armed"] is False
    assert repo.transitions[-1] == ("session-1", "active", "ended")


def test_ready_end_is_rejected():
    repo = FakeRepository({"session-1": session_row("ready")})
    orchestrator, _ = build(repo)
    with pytest.raises(ValueError):
        orchestrator.end_exam_session("session-1")
    assert repo.sessions["session-1"]["status"] == "ready"


def test_draft_end_is_rejected():
    repo = FakeRepository({"session-1": session_row("draft")})
    orchestrator, _ = build(repo)
    with pytest.raises(ValueError):
        orchestrator.end_exam_session("session-1")
    assert repo.sessions["session-1"]["status"] == "draft"


def test_no_subject_can_be_created_after_a_successful_end():
    repo = FakeRepository({"session-1": session_row("ready")})
    orchestrator, runtime = build(repo)
    orchestrator.arm_exam_session("session-1")
    orchestrator.end_exam_session("session-1")
    assert runtime.observe(frame("cam-1", "raw-new", LEFT, at(5.0))) is None
    assert runtime.snapshots("session-1") == ()


def test_unknown_session_is_reported_as_missing():
    orchestrator, _ = build(FakeRepository({}))
    with pytest.raises(LookupError):
        orchestrator.arm_exam_session("nope")
    with pytest.raises(LookupError):
        orchestrator.end_exam_session("nope")


# ================================== END STOP BOUNDARY / FRAME DRAIN (18-22)


def _inflight_frame(orchestrator, runtime, log, *, moment=at(1.0)):
    """Mimics the camera path: state mutation inside the camera lifecycle lock."""

    def run() -> None:
        with orchestrator.cameras.lock("cam-1"):
            log.append("frame-enter")
            time.sleep(0.15)
            runtime.observe(frame("cam-1", "raw-a", LEFT, moment))
            log.append("frame-exit")

    return threading.Thread(target=run, name="inflight-frame")


def test_end_waits_for_an_inflight_frame_before_persisting_ended():
    log: list[str] = []
    repo = FakeRepository({"session-1": session_row("ready")})
    orchestrator, runtime = build(repo)
    orchestrator.arm_exam_session("session-1")
    feed(runtime, "cam-1", "raw-a", LEFT)

    original = repo.transition_exam_session

    def recording(exam_session_id, **kwargs):  # noqa: ANN001, ANN003
        log.append("persist")
        return original(exam_session_id, **kwargs)

    repo.transition_exam_session = recording  # type: ignore[assignment]

    worker = _inflight_frame(orchestrator, runtime, log)
    worker.start()
    while "frame-enter" not in log:
        time.sleep(0.005)
    orchestrator.end_exam_session("session-1")
    worker.join(5)
    assert log.index("frame-exit") < log.index("persist")
    assert repo.sessions["session-1"]["status"] == "ended"


def test_a_later_frame_cannot_enter_processing_while_end_holds_camera_locks():
    repo = FakeRepository({"session-1": session_row("ready")})
    orchestrator, runtime = build(repo)
    orchestrator.arm_exam_session("session-1")
    entered: list[bool] = []
    original = repo.transition_exam_session

    def probing(exam_session_id, **kwargs):  # noqa: ANN001, ANN003
        def probe() -> None:
            acquired = orchestrator.cameras.lock("cam-1").acquire(blocking=False)
            entered.append(acquired)
            if acquired:
                orchestrator.cameras.lock("cam-1").release()

        thread = threading.Thread(target=probe)
        thread.start()
        thread.join(5)
        return original(exam_session_id, **kwargs)

    repo.transition_exam_session = probing  # type: ignore[assignment]
    orchestrator.end_exam_session("session-1")
    assert entered == [False]  # the stop boundary keeps later frames out


def test_after_the_end_boundary_no_frame_produces_subject_state_or_attribution():
    repo = FakeRepository({"session-1": session_row("ready")})
    orchestrator, runtime = build(repo)
    orchestrator.arm_exam_session("session-1")
    feed(runtime, "cam-1", "raw-a", LEFT)
    orchestrator.end_exam_session("session-1")

    with orchestrator.cameras.lock("cam-1"):
        assert runtime.observe(frame("cam-1", "raw-a", LEFT, at(3.0))) is None
        assert runtime.observe(frame("cam-1", "raw-new", LEFT, at(3.2))) is None
    # No exam session owns the camera, so no exam attribution can be derived.
    assert runtime.owner_of("cam-1") is None
    assert runtime.snapshots("session-1") == ()
    assert not runtime.is_armed("session-1")


def test_end_persistence_failure_after_drain_resumes_and_keeps_monitoring():
    log: list[str] = []
    repo = FakeRepository({"session-1": session_row("ready")}, fail_transition_to="ended")
    orchestrator, runtime = build(repo)
    orchestrator.arm_exam_session("session-1")
    feed(runtime, "cam-1", "raw-a", LEFT)

    worker = _inflight_frame(orchestrator, runtime, log)
    worker.start()
    while "frame-enter" not in log:
        time.sleep(0.005)
    with pytest.raises(RuntimeError):
        orchestrator.end_exam_session("session-1")
    worker.join(5)

    assert "frame-exit" in log
    assert repo.sessions["session-1"]["status"] == "active"
    assert runtime.is_armed("session-1")
    assert runtime.owner_of("cam-1") == "session-1"
    result = feed(runtime, "cam-1", "raw-a", LEFT, start=2.0)
    assert result is not None
    assert [item.subject_number for item in runtime.snapshots("session-1")] == [1]


def test_end_acquires_camera_locks_in_deterministic_sorted_order():
    repo = FakeRepository(
        {"session-1": {"id": "session-1", "status": "ready", "camera_ids": ["cam-2", "cam-1"]}}
    )
    orchestrator, _ = build(repo, cameras=("cam-1", "cam-2"))
    orchestrator.arm_exam_session("session-1")
    orchestrator.cameras.lock_order.clear()
    orchestrator.end_exam_session("session-1")
    assert orchestrator.cameras.lock_order == ["cam-1", "cam-2"]
