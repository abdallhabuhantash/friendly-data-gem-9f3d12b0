"""Proof that lost tracking continuity can never mint a duplicate identity.

The defect under test: a person who already owns S001 in an exam session must
never receive S002 merely because the camera stream restarted or the AI service
was restarted. Either the returning track is recovered onto S001, or it stays
UNRESOLVED — a NEW permanent number is never allocated while continuity of a
pre-interruption subject is still unproven.

All cases are pure: explicit timestamps, no clocks, no models, no database.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app.ai.subject_registry import CONTINUITY_HOLD_REASON, ExamSubjectRegistry
from app.domain.geometry import BBox
from app.domain.observations import PersonObservation
from app.domain.session_subjects import (
    UNRESOLVED_TRACK_LABEL,
    ContinuityMode,
    MotionState,
    RestoredSubject,
    SubjectLifecycle,
    SubjectRegistryConfig,
    TrackAssociation,
    subject_label,
)

T0 = datetime(2026, 3, 1, 9, 0, 0, tzinfo=timezone.utc)

LEFT = BBox(0.10, 0.40, 0.10, 0.30)
LEFT_SHIFTED = BBox(0.12, 0.41, 0.10, 0.30)
RIGHT = BBox(0.70, 0.40, 0.10, 0.30)


def at(seconds: float) -> datetime:
    return T0 + timedelta(seconds=seconds)


def config(**overrides) -> SubjectRegistryConfig:
    base = dict(
        min_frames_to_qualify=3,
        min_seconds_to_qualify=0.3,
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
    base.update(overrides)
    return SubjectRegistryConfig(**base)  # type: ignore[arg-type]


def registry(**overrides) -> ExamSubjectRegistry:
    return ExamSubjectRegistry(
        exam_session_id="session-1",
        camera_id="camera-1",
        config=config(**overrides),
    )


def person(tracking_id, box: BBox) -> PersonObservation:
    return PersonObservation(
        person_tracking_id=tracking_id,
        person_bbox=box,
        confidence=0.9,
    )


def feed(reg: ExamSubjectRegistry, raw_id, box: BBox, start: float, frames: int = 4):
    result = None
    for index in range(frames):
        result = reg.update([person(raw_id, box)], observed_at=at(start + index * 0.2))
    return result


def restored(motion: bool) -> RestoredSubject:
    return RestoredSubject(
        subject_number=1,
        first_seen_at=T0,
        last_seen_at=at(1.0),
        motion=MotionState(
            last_bbox=LEFT,
            velocity_x=0.0,
            velocity_y=0.0,
            updated_at=at(1.0),
        )
        if motion
        else None,
    )


# ------------------------------------------------------- restore establishes hold


def test_restore_with_motion_is_recovering_and_reserves_the_number():
    reg = registry()
    reg.restore([restored(motion=True)])
    assert reg.continuity is ContinuityMode.RECOVERING
    assert reg.awaiting_continuity == (1,)
    snapshot = reg.snapshots()[0]
    assert snapshot.subject_number == 1
    assert snapshot.lifecycle is SubjectLifecycle.TEMPORARILY_LOST
    assert snapshot.association is TrackAssociation.UNRESOLVED
    assert snapshot.active_tracking_id is None


def test_restore_without_motion_is_compromised():
    reg = registry()
    reg.restore([restored(motion=False)])
    assert reg.continuity is ContinuityMode.COMPROMISED
    assert reg.snapshots()[0].lifecycle is SubjectLifecycle.LOST


def test_legacy_tuple_rows_are_still_accepted():
    reg = registry()
    reg.restore([(1, T0, at(1.0))])
    assert reg.snapshots()[0].subject_number == 1
    assert reg.continuity is ContinuityMode.COMPROMISED


# --------------------------------------------------- the actual defect: no S002


def test_returning_person_recovers_the_same_number_after_a_reset():
    reg = registry()
    reg.restore([restored(motion=True)])
    result = feed(reg, "raw-new", LEFT_SHIFTED, start=1.2)
    assert [item.subject_number for item in reg.snapshots()] == [1]
    assert reg.snapshots()[0].active_tracking_id == "raw-new"
    assert reg.continuity is ContinuityMode.HEALTHY
    assert result is not None
    assert subject_label(2) not in dict(result.labels).values()


def test_unrecoverable_track_stays_unresolved_instead_of_getting_a_new_number():
    reg = registry()
    reg.restore([restored(motion=False)])
    result = feed(reg, "raw-new", RIGHT, start=1.2, frames=10)
    assert [item.subject_number for item in reg.snapshots()] == [1]
    assert reg.snapshots()[0].active_tracking_id is None
    assert result is not None
    assert dict(result.labels)["raw-new"] == UNRESOLVED_TRACK_LABEL
    assert result.continuity is ContinuityMode.COMPROMISED
    pending = {item.raw_tracking_id: item.reason for item in result.unresolved}
    assert pending["raw-new"] == CONTINUITY_HOLD_REASON


def test_hold_applies_to_every_track_while_recovery_is_pending():
    """Even a clearly different person waits: identity beats throughput."""
    reg = registry()
    reg.restore([restored(motion=True)])
    result = feed(reg, "raw-far", RIGHT, start=1.2, frames=6)
    assert [item.subject_number for item in reg.snapshots()] == [1]
    assert result is not None
    assert dict(result.labels)["raw-far"] == UNRESOLVED_TRACK_LABEL


def test_new_numbering_resumes_once_continuity_is_reestablished():
    reg = registry()
    reg.restore([restored(motion=True)])
    feed(reg, "raw-a", LEFT_SHIFTED, start=1.2)
    assert reg.continuity is ContinuityMode.HEALTHY
    result = feed(reg, "raw-b", RIGHT, start=2.4)
    numbers = sorted(item.subject_number for item in reg.snapshots())
    assert numbers == [1, 2]
    assert result is not None
    assert dict(result.labels)["raw-b"] == subject_label(2)


def test_numbering_stays_reserved_so_recovery_never_reuses_a_number():
    reg = registry()
    reg.restore([restored(motion=True)])
    feed(reg, "raw-a", LEFT_SHIFTED, start=1.2)
    feed(reg, "raw-b", RIGHT, start=2.4)
    assert reg.snapshots()[0].subject_number == 1
    assert reg.snapshots()[1].subject_number == 2


def test_closing_the_session_clears_the_continuity_guard():
    reg = registry()
    reg.restore([restored(motion=True)])
    reg.close(ended_at=at(5.0))
    assert reg.continuity is ContinuityMode.HEALTHY
    assert reg.awaiting_continuity == ()
