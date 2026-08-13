"""Production restart path: an ACTIVE exam is never subject-armed empty.

These tests exercise the orchestration path (``_sync_armed_sessions`` →
``SubjectRuntime.sync`` → hydrated ``arm``), not just the pure registry. The
defect under test: on service restart, an exam whose database status is already
``active`` could be armed with an empty registry before its persisted S-numbers
were restored, which could mint a duplicate permanent identity.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app.domain.geometry import BBox
from app.domain.observations import FrameObservations, PersonObservation
from app.domain.session_subjects import (
    UNRESOLVED_TRACK_LABEL,
    ContinuityMode,
    SubjectRegistryConfig,
    subject_label,
)
from app.events.subject_state_publisher import SubjectStatePublisher
from app.runtime.orchestrator import Orchestrator
from app.runtime.subject_runtime import ArmedSession, SubjectRuntime

T0 = datetime(2026, 3, 1, 9, 0, 0, tzinfo=timezone.utc)
LEFT = BBox(0.10, 0.40, 0.10, 0.30)
LEFT_SHIFTED = BBox(0.12, 0.41, 0.10, 0.30)
RIGHT = BBox(0.70, 0.40, 0.10, 0.30)

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


def frame(camera_id: str, tracking_id, box: BBox, moment: datetime) -> FrameObservations:
    return FrameObservations(
        camera_id=camera_id,
        persons=(PersonObservation(tracking_id, box, 0.9),),
        observed_at=moment,
    )


def feed(runtime: SubjectRuntime, camera_id: str, raw_id, box: BBox, start: float, frames: int = 4):
    result = None
    for index in range(frames):
        result = runtime.observe(frame(camera_id, raw_id, box, at(start + index * 0.2)))
    return result


class FakeRepository:
    """The database as seen after a restart: one ACTIVE exam owning S001."""

    def __init__(self, *, motion: bool = True, history_fails: bool = False) -> None:
        self.motion = motion
        self.history_fails = history_fails
        self.history_reads = 0

    def upsert_session_subject(self, payload: dict) -> str:
        return f"row-{payload['subject_number']}"

    def open_subject_track(self, **kwargs) -> None:  # noqa: ANN003
        pass

    def close_subject_track(self, **kwargs) -> None:  # noqa: ANN003
        pass

    def armed_exam_sessions(self) -> list[dict]:
        return [{"id": "session-1", "camera_ids": ["cam-1"]}]

    def existing_subject_rows(self, exam_session_id: str) -> dict[int, str]:
        return {1: "row-1"}

    def open_subject_history(self, exam_session_id: str) -> list[dict]:
        self.history_reads += 1
        if self.history_fails:
            raise RuntimeError("database unreachable")
        row = {
            "camera_id": "cam-1",
            "subject_number": 1,
            "first_seen_at": T0.isoformat(),
            "last_seen_at": at(1.0).isoformat(),
        }
        if self.motion:
            row.update(
                {
                    "last_bbox_x": LEFT.x,
                    "last_bbox_y": LEFT.y,
                    "last_bbox_width": LEFT.width,
                    "last_bbox_height": LEFT.height,
                    "velocity_x": 0.0,
                    "velocity_y": 0.0,
                    "motion_updated_at": at(1.0).isoformat(),
                }
            )
        return row and [row]


def restarted(repository: FakeRepository) -> tuple[Orchestrator, SubjectRuntime]:
    """A fresh runtime, as after a process restart, on the production sync path."""
    publisher = SubjectStatePublisher(repository, heartbeat_seconds=5.0)
    runtime = SubjectRuntime(CONFIG, publisher)
    orchestrator = object.__new__(Orchestrator)
    orchestrator.repository = repository  # type: ignore[attr-defined]
    orchestrator.subject_publisher = publisher  # type: ignore[attr-defined]
    orchestrator.subjects = runtime  # type: ignore[attr-defined]
    return orchestrator, runtime


# ------------------------------------------------ restart hydration is atomic


def test_sync_restores_persisted_subject_before_any_frame_is_accepted():
    repo = FakeRepository()
    orchestrator, runtime = restarted(repo)
    orchestrator._sync_armed_sessions()
    assert runtime.is_armed("session-1")
    numbers = [item.subject_number for item in runtime.snapshots("session-1")]
    assert numbers == [1]
    assert repo.history_reads == 1


def test_no_frame_can_enter_an_empty_registry_during_hydration():
    """Fails if ownership were published before restoration finished."""
    repo = FakeRepository()
    publisher = SubjectStatePublisher(repo, heartbeat_seconds=5.0)
    runtime = SubjectRuntime(CONFIG, publisher)
    seen: list = []

    def hydrate(session: ArmedSession):
        # Mid-hydration a live inference frame arrives.
        seen.append(runtime.observe(frame("cam-1", "raw-new", LEFT_SHIFTED, at(1.2))))
        return ((("cam-1", _restored_row()),), 1)

    runtime.sync([ArmedSession("session-1", ("cam-1",))], hydrate=hydrate)
    assert seen == [None]
    assert [item.subject_number for item in runtime.snapshots("session-1")] == [1]


def _restored_row():
    from app.domain.session_subjects import MotionState, RestoredSubject

    return RestoredSubject(
        subject_number=1,
        first_seen_at=T0,
        last_seen_at=at(1.0),
        motion=MotionState(last_bbox=LEFT, velocity_x=0.0, velocity_y=0.0, updated_at=at(1.0)),
    )


def test_returning_safe_track_recovers_the_original_number_after_restart():
    orchestrator, runtime = restarted(FakeRepository())
    orchestrator._sync_armed_sessions()
    result = feed(runtime, "cam-1", "raw-new", LEFT_SHIFTED, start=1.2)
    assert [item.subject_number for item in runtime.snapshots("session-1")] == [1]
    assert result is not None
    assert dict(result.labels)["raw-new"] == subject_label(1)


def test_ambiguous_returning_track_stays_unresolved_and_never_becomes_s002():
    orchestrator, runtime = restarted(FakeRepository(motion=False))
    orchestrator._sync_armed_sessions()
    result = feed(runtime, "cam-1", "raw-new", RIGHT, start=1.2, frames=10)
    assert [item.subject_number for item in runtime.snapshots("session-1")] == [1]
    assert result is not None
    assert dict(result.labels)["raw-new"] == UNRESOLVED_TRACK_LABEL
    assert result.continuity is ContinuityMode.COMPROMISED


# ------------------------------------------------------------- fail closed


def test_unreadable_history_leaves_an_active_session_unarmed():
    repo = FakeRepository(history_fails=True)
    orchestrator, runtime = restarted(repo)
    orchestrator._sync_armed_sessions()
    assert not runtime.is_armed("session-1")
    # Ordinary inference keeps running; subject identity simply is not armed.
    assert runtime.observe(frame("cam-1", "raw-new", LEFT, at(1.2))) is None


def test_recovered_history_arms_on_a_later_sync_pass():
    repo = FakeRepository(history_fails=True)
    orchestrator, runtime = restarted(repo)
    orchestrator._sync_armed_sessions()
    repo.history_fails = False
    orchestrator._sync_armed_sessions()
    assert runtime.is_armed("session-1")
    assert [item.subject_number for item in runtime.snapshots("session-1")] == [1]


# --------------------------------------------------- fresh first-time arming


def test_fresh_session_without_history_starts_from_a_clean_registry():
    class Empty(FakeRepository):
        def existing_subject_rows(self, exam_session_id: str) -> dict[int, str]:
            return {}

        def open_subject_history(self, exam_session_id: str) -> list[dict]:
            return []

    orchestrator, runtime = restarted(Empty())
    orchestrator._sync_armed_sessions()
    assert runtime.snapshots("session-1") == ()
    result = feed(runtime, "cam-1", "raw-a", LEFT, start=0.0)
    assert result is not None
    assert dict(result.labels)["raw-a"] == subject_label(1)
