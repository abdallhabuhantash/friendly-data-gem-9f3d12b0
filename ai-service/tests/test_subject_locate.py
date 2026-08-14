"""Read-only locate of an existing anonymous exam subject.

Locate must be observation-only: it reports the last ACTUALLY observed bounding
box of a proven subject, and returns no box at all for every uncertain state.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from app.domain.geometry import BBox
from app.domain.observations import FrameObservations, PersonObservation
from app.domain.session_subjects import (
    SubjectLifecycle,
    SubjectRegistryConfig,
    SubjectSnapshot,
    TrackAssociation,
    initial_motion,
)
from app.domain.subject_locate import (
    LocateState,
    SubjectLocation,
    locate_from_candidates,
)
from app.events.subject_state_publisher import SubjectStatePublisher
from app.runtime.subject_runtime import ArmedSession, SubjectRuntime

T0 = datetime(2026, 4, 1, 9, 0, 0, tzinfo=timezone.utc)
BOX = BBox(0.20, 0.40, 0.10, 0.30)

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


def frame(camera_id: str, tracking_id: str, box: BBox, moment: datetime):
    return FrameObservations(
        camera_id=camera_id,
        persons=(PersonObservation(tracking_id, box, 0.9),),
        observed_at=moment,
    )


class FakeRepository:
    def upsert_session_subject(self, payload: dict) -> str:
        return "row"

    def open_subject_track(self, **kwargs) -> None:
        pass

    def close_subject_track(self, **kwargs) -> None:
        pass


def runtime() -> SubjectRuntime:
    publisher = SubjectStatePublisher(FakeRepository(), heartbeat_seconds=5.0)
    return SubjectRuntime(CONFIG, publisher)


def snapshot(
    *,
    number: int = 1,
    lifecycle: SubjectLifecycle = SubjectLifecycle.ACTIVE,
    association: TrackAssociation = TrackAssociation.CONFIRMED,
    motion=initial_motion(BOX, T0, trajectory_length=4),
) -> SubjectSnapshot:
    return SubjectSnapshot(
        subject_number=number,
        label=f"S{number:03d}",
        lifecycle=lifecycle,
        association=association,
        first_seen_at=T0,
        last_seen_at=at(2.0),
        ended_at=at(3.0) if lifecycle is SubjectLifecycle.ENDED else None,
        active_tracking_id="7",
        motion=motion,
        recovery_count=0,
        last_association_confidence=0.9,
        segments=(),
    )


# --- pure decision contract -------------------------------------------------


def test_unarmed_session_is_never_guessed():
    result = locate_from_candidates("s1", 1, armed=False)
    assert result.locate_state is LocateState.NOT_ARMED
    assert result.bbox is None and result.camera_id is None


def test_unknown_subject_number_is_not_found():
    result = locate_from_candidates("s1", 9, armed=True, candidates=())
    assert result.locate_state is LocateState.NOT_FOUND
    assert result.bbox is None


def test_proven_subject_reports_the_last_observed_box():
    result = locate_from_candidates(
        "s1", 1, armed=True, candidates=[("cam-1", snapshot())]
    )
    assert result.locate_state is LocateState.LOCATED
    assert result.camera_id == "cam-1"
    assert result.bbox == BOX
    assert result.subject_label == "S001"


@pytest.mark.parametrize(
    ("lifecycle", "association", "state"),
    [
        (SubjectLifecycle.TEMPORARILY_LOST, TrackAssociation.CONFIRMED, LocateState.TEMPORARILY_LOST),
        (SubjectLifecycle.LOST, TrackAssociation.CONFIRMED, LocateState.LOST),
        (SubjectLifecycle.ENDED, TrackAssociation.CONFIRMED, LocateState.ENDED),
        (SubjectLifecycle.ACTIVE, TrackAssociation.UNRESOLVED, LocateState.UNRESOLVED),
        (SubjectLifecycle.ACTIVE, TrackAssociation.PROVISIONAL, LocateState.PROVISIONAL),
        (SubjectLifecycle.ACTIVE, TrackAssociation.CONFLICT, LocateState.CONFLICT),
    ],
)
def test_every_uncertain_state_returns_no_box(lifecycle, association, state):
    result = locate_from_candidates(
        "s1",
        1,
        armed=True,
        candidates=[("cam-1", snapshot(lifecycle=lifecycle, association=association))],
    )
    assert result.locate_state is state
    assert result.bbox is None


def test_missing_or_degenerate_motion_is_unavailable_not_located():
    without = locate_from_candidates(
        "s1", 1, armed=True, candidates=[("cam-1", snapshot(motion=None))]
    )
    assert without.locate_state is LocateState.UNAVAILABLE and without.bbox is None
    flat = initial_motion(BBox(0.1, 0.1, 0.0, 0.0), T0, trajectory_length=4)
    degenerate = locate_from_candidates(
        "s1", 1, armed=True, candidates=[("cam-1", snapshot(motion=flat))]
    )
    assert degenerate.locate_state is LocateState.UNAVAILABLE
    assert degenerate.bbox is None


def test_same_number_on_two_cameras_fails_closed():
    result = locate_from_candidates(
        "s1",
        1,
        armed=True,
        candidates=[("cam-1", snapshot()), ("cam-2", snapshot())],
    )
    assert result.locate_state is LocateState.AMBIGUOUS
    assert result.bbox is None and result.camera_id is None


def test_a_box_can_never_accompany_a_non_located_state():
    with pytest.raises(ValueError):
        SubjectLocation(
            exam_session_id="s1",
            subject_number=1,
            subject_label="S001",
            locate_state=LocateState.LOST,
            bbox=BOX,
        )


def test_payload_is_anonymous_and_json_safe():
    payload = locate_from_candidates(
        "s1", 1, armed=True, candidates=[("cam-1", snapshot())]
    ).payload()
    assert payload["subject_label"] == "S001"
    assert payload["locate_state"] == "located"
    assert payload["bbox"] == {"x": 0.20, "y": 0.40, "width": 0.10, "height": 0.30}
    assert "active_tracking_id" not in payload
    assert "7" not in repr(payload)


# --- runtime read-only behaviour -------------------------------------------


def test_runtime_locate_reports_a_live_subject_and_changes_nothing():
    subjects = runtime()
    subjects.arm(ArmedSession("session-1", ("cam-1",)))
    for index in range(3):
        subjects.observe(frame("cam-1", "7", BOX, at(index * 0.2)))
    before = subjects.snapshots("session-1")
    located = subjects.locate("session-1", 1)
    assert located.locate_state is LocateState.LOCATED
    assert located.camera_id == "cam-1"
    assert subjects.snapshots("session-1") == before


def test_runtime_locate_of_an_unarmed_session_is_not_armed():
    subjects = runtime()
    assert subjects.locate("session-x", 1).locate_state is LocateState.NOT_ARMED


def test_runtime_locate_never_allocates_a_number():
    subjects = runtime()
    subjects.arm(ArmedSession("session-1", ("cam-1",)))
    assert subjects.locate("session-1", 4).locate_state is LocateState.NOT_FOUND
    assert subjects.snapshots("session-1") == ()
