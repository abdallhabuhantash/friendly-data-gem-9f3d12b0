"""Fail-closed proof: a phone event is attributed ONLY to the subject the
engine itself proved owns the phone.

People merely visible in the same analysed frame are never event participants,
so UNCERTAIN / UNASSOCIATED phone events stay anonymous even when every visible
track is a CONFIRMED exam subject.

These tests drive the real `PhoneRuleEngine` and then apply attribution exactly
as `Orchestrator._process_frame` does.
"""

from __future__ import annotations

import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from app.ai.phone_rule_engine import PhoneRuleEngine
from app.domain.event_attribution import attribute_event_subjects
from app.domain.geometry import BBox
from app.domain.models import (
    AssociationStatus,
    CameraConfig,
    Detection,
    FrameDetections,
    RuleConfig,
    SourceType,
)
from app.domain.session_subjects import (
    SubjectFrameResult,
    SubjectLifecycle,
    SubjectSnapshot,
    TrackAssociation,
)

NOW = datetime(2026, 3, 1, 9, 0, tzinfo=timezone.utc)
SESSION = "22222222-2222-2222-2222-222222222222"
CAMERA = CameraConfig(id="cam-1", name="Hall A", source_type=SourceType.DEMO)


def person(tid: str, x: float, conf: float = 0.9) -> Detection:
    return Detection("person", conf, BBox(x, 0.3, 0.18, 0.6), tid)


def phone(x: float, y: float = 0.5, conf: float = 0.85) -> Detection:
    return Detection("cell_phone", conf, BBox(x, y, 0.04, 0.07), "ph-1")


def rule(**overrides) -> RuleConfig:
    base = dict(
        id="rule-1",
        name="Mobile phone",
        engine_key="mobile_phone_detection",
        available=True,
        enabled=True,
        severity="critical",
        confidence_threshold=0.6,
        person_confidence_threshold=0.5,
        association_confidence_threshold=0.65,
        min_duration_seconds=1.0,
        min_matching_frames=3,
        cooldown_seconds=30,
        require_person_association=True,
        instant_detection_enabled=False,
    )
    base.update(overrides)
    return RuleConfig(**base)


def snapshot(
    number: int,
    raw_id: Optional[str],
    *,
    association: TrackAssociation = TrackAssociation.CONFIRMED,
) -> SubjectSnapshot:
    return SubjectSnapshot(
        subject_number=number,
        label=f"S{number:03d}",
        lifecycle=SubjectLifecycle.ACTIVE,
        association=association,
        first_seen_at=NOW,
        last_seen_at=NOW,
        ended_at=None,
        active_tracking_id=raw_id,
        motion=None,
        recovery_count=0,
        last_association_confidence=0.9,
        segments=(),
    )


def frame_result(*subjects: SubjectSnapshot) -> SubjectFrameResult:
    return SubjectFrameResult(
        exam_session_id=SESSION,
        camera_id=CAMERA.id,
        observed_at=NOW,
        subjects=tuple(subjects),
    )


def confirmed_event(detections: FrameDetections):
    """Runs the real engine until it confirms exactly one temporal event."""
    engine = PhoneRuleEngine()
    start = time.monotonic()
    drafts: list = []
    for step in range(12):
        drafts += engine.process_frame(
            camera=CAMERA,
            rule=rule(),
            detections=detections,
            now=start + step * 0.25,
            source_mode="live",
        )
    assert len(drafts) == 1
    return drafts[0].event


def attribute_like_runtime(event, result: SubjectFrameResult):
    """Mirrors the orchestrator: exam session recorded, engine-proven tracks only."""
    event.exam_session_id = result.exam_session_id
    event.subject_links = attribute_event_subjects(
        result,
        primary_tracking_id=event.person_tracking_id,
        additional_tracking_ids=(),
    )
    return event


def test_associated_phone_links_only_the_owning_subject() -> None:
    event = confirmed_event(
        FrameDetections((person("t1", 0.40),), (phone(0.42),))
    )
    assert event.association_status is AssociationStatus.ASSOCIATED
    assert event.person_tracking_id == "t1"

    attribute_like_runtime(event, frame_result(snapshot(1, "t1"), snapshot(2, "t2")))
    assert [link.subject_label for link in event.subject_links] == ["S001"]
    assert event.subject_links[0].participant_index == 1


def test_uncertain_phone_event_persists_unattributed() -> None:
    event = confirmed_event(
        FrameDetections((person("t1", 0.40), person("t2", 0.46)), (phone(0.5),))
    )
    assert event.association_status is AssociationStatus.UNCERTAIN
    assert event.person_tracking_id is None
    # Evidence names both visible people; attribution must ignore that entirely.
    assert {item.tracking_id for item in event.evidence} >= {"t1", "t2"}

    attribute_like_runtime(event, frame_result(snapshot(1, "t1"), snapshot(2, "t2")))
    assert event.exam_session_id == SESSION
    assert event.subject_links == ()


def test_unassociated_phone_event_persists_unattributed() -> None:
    event = confirmed_event(
        FrameDetections((person("t1", 0.05), person("t2", 0.9)), (phone(0.5, 0.02),))
    )
    assert event.association_status is AssociationStatus.UNASSOCIATED
    assert event.person_tracking_id is None

    attribute_like_runtime(event, frame_result(snapshot(1, "t1"), snapshot(2, "t2")))
    assert event.exam_session_id == SESSION
    assert event.subject_links == ()


def test_associated_phone_on_unresolved_track_is_not_attributed() -> None:
    event = confirmed_event(FrameDetections((person("t1", 0.40),), (phone(0.42),)))
    result = frame_result(
        snapshot(1, "t1", association=TrackAssociation.UNRESOLVED),
        snapshot(2, "t2"),
    )
    attribute_like_runtime(event, result)
    assert event.exam_session_id == SESSION
    assert event.subject_links == ()


def test_runtime_never_infers_participants_from_generic_evidence() -> None:
    source = Path(__file__).resolve().parents[1] / "app" / "runtime" / "orchestrator.py"
    assert "evidence_person_tracking_ids" not in source.read_text(encoding="utf-8")
