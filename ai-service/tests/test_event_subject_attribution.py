"""Deterministic proof for event -> anonymous subject attribution.

Covers the truthfulness rules of `app/domain/event_attribution.py` and the
durable, retry-safe attribution path of `EventPublisher`.
"""

from __future__ import annotations

import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

import pytest

from app.domain.event_attribution import (
    LINK_METHOD_FRAME_OWNERSHIP,
    attribute_event_subjects,
    evidence_person_tracking_ids,
)
from app.domain.geometry import BBox
from app.domain.models import AiEvent, AssociationStatus, EvidenceItem
from app.domain.session_subjects import (
    SubjectFrameResult,
    SubjectLifecycle,
    SubjectSnapshot,
    TrackAssociation,
)
from app.events.event_publisher import EventPublisher
from app.infrastructure.offline_queue import OfflineQueue

NOW = datetime(2026, 3, 1, 9, 0, tzinfo=timezone.utc)
#: Far enough ahead of wall-clock time that any recorded backoff has elapsed.
def future_moment() -> float:
    return time.time() + 86_400.0
SESSION = "11111111-1111-1111-1111-111111111111"


def snapshot(
    number: int,
    raw_id: Optional[str],
    *,
    association: TrackAssociation = TrackAssociation.CONFIRMED,
    lifecycle: SubjectLifecycle = SubjectLifecycle.ACTIVE,
    confidence: Optional[float] = 0.9,
) -> SubjectSnapshot:
    return SubjectSnapshot(
        subject_number=number,
        label=f"S{number:03d}",
        lifecycle=lifecycle,
        association=association,
        first_seen_at=NOW,
        last_seen_at=NOW,
        ended_at=None,
        active_tracking_id=raw_id,
        motion=None,
        recovery_count=0,
        last_association_confidence=confidence,
        segments=(),
    )


def frame_result(*subjects: SubjectSnapshot) -> SubjectFrameResult:
    return SubjectFrameResult(
        exam_session_id=SESSION,
        camera_id="cam-1",
        observed_at=NOW,
        subjects=tuple(subjects),
    )


# --- pure attribution ------------------------------------------------------


def test_confirmed_owner_is_attributed() -> None:
    links = attribute_event_subjects(
        frame_result(snapshot(1, "t-7")), primary_tracking_id="t-7"
    )
    assert len(links) == 1
    assert links[0].subject_number == 1
    assert links[0].subject_label == "S001"
    assert links[0].participant_index == 1
    assert links[0].participant_role == "primary"
    assert links[0].link_method == LINK_METHOD_FRAME_OWNERSHIP
    assert links[0].link_confidence == pytest.approx(0.9)


def test_unresolved_track_is_never_attributed() -> None:
    result = frame_result(snapshot(1, "t-7", association=TrackAssociation.UNRESOLVED))
    assert attribute_event_subjects(result, primary_tracking_id="t-7") == ()


def test_unknown_track_is_never_attributed() -> None:
    result = frame_result(snapshot(1, "t-7"))
    assert attribute_event_subjects(result, primary_tracking_id="t-99") == ()


def test_ended_subject_is_never_attributed() -> None:
    result = frame_result(snapshot(1, "t-7", lifecycle=SubjectLifecycle.ENDED))
    assert attribute_event_subjects(result, primary_tracking_id="t-7") == ()


def test_no_subject_result_means_no_attribution() -> None:
    assert attribute_event_subjects(None, primary_tracking_id="t-7") == ()


def test_missing_primary_track_yields_no_links() -> None:
    result = frame_result(snapshot(1, "t-7"))
    assert attribute_event_subjects(result, primary_tracking_id=None) == ()


def test_multiple_participants_are_ordered_and_deduplicated() -> None:
    result = frame_result(snapshot(1, "t-1"), snapshot(2, "t-2"), snapshot(3, "t-3"))
    links = attribute_event_subjects(
        result,
        primary_tracking_id="t-2",
        additional_tracking_ids=["t-2", "  ", None, "t-3", "t-1"],
    )
    assert [(link.participant_index, link.subject_number) for link in links] == [
        (1, 2),
        (2, 3),
        (3, 1),
    ]
    assert links[0].participant_role == "primary"
    assert links[1].participant_role == "counterpart"


def test_partial_ownership_attributes_only_the_proven_participant() -> None:
    result = frame_result(
        snapshot(1, "t-1"), snapshot(2, "t-2", association=TrackAssociation.UNRESOLVED)
    )
    links = attribute_event_subjects(
        result, primary_tracking_id="t-1", additional_tracking_ids=["t-2"]
    )
    assert [link.subject_number for link in links] == [1]
    assert links[0].participant_index == 1


# --- durable publishing path ----------------------------------------------


class FakeRepo:
    """Minimal repository double with switchable failure modes."""

    def __init__(self) -> None:
        self.events: list[dict[str, Any]] = []
        self.links: list[dict[str, Any]] = []
        self.subject_rows: dict[tuple[str, int], str] = {}
        self.insert_events_fail = False
        self.link_inserts_fail = False

    def insert_event(self, row: dict[str, Any]) -> None:
        if self.insert_events_fail:
            raise RuntimeError("offline")
        self.events.append(row)

    def session_subject_row_id(self, exam_session_id: str, subject_number: int) -> Optional[str]:
        return self.subject_rows.get((exam_session_id, int(subject_number)))

    def insert_event_subject(self, row: dict[str, Any]) -> None:
        if self.link_inserts_fail:
            raise RuntimeError("offline")
        self.links.append(row)


def make_event(**kwargs: Any) -> AiEvent:
    event = AiEvent(
        id="event-1",
        type="mobile_phone_detected",
        severity="warning",
        camera_id="cam-1",
        camera_name="Hall A",
        rule_id="rule-1",
        confidence=0.9,
        trigger_object_class="cell_phone",
        trigger_confidence=0.9,
        association_status=AssociationStatus.ASSOCIATED,
        association_confidence=0.8,
        detection_duration_seconds=1.0,
        detection_frame_count=3,
        source_mode="live",
        detected_at=NOW,
        person_tracking_id="t-7",
    )
    for key, value in kwargs.items():
        setattr(event, key, value)
    return event


@pytest.fixture()
def queue(tmp_path: Path) -> OfflineQueue:
    return OfflineQueue(tmp_path / "queue.db")


def test_event_row_carries_the_exam_session() -> None:
    row = make_event(exam_session_id=SESSION).to_row()
    assert row["exam_session_id"] == SESSION


def test_ordinary_event_has_no_exam_session_and_no_links(queue: OfflineQueue) -> None:
    repo = FakeRepo()
    publisher = EventPublisher(repo, queue)
    assert publisher.publish(make_event()) is True
    assert repo.events[0]["exam_session_id"] is None
    assert repo.links == []
    assert queue.subject_link_depth() == 0


def test_link_is_written_after_the_event_row(queue: OfflineQueue) -> None:
    repo = FakeRepo()
    repo.subject_rows[(SESSION, 1)] = "subject-row-1"
    publisher = EventPublisher(repo, queue)
    links = attribute_event_subjects(frame_result(snapshot(1, "t-7")), primary_tracking_id="t-7")

    assert publisher.publish(make_event(exam_session_id=SESSION, subject_links=links)) is True
    assert len(repo.links) == 1
    assert repo.links[0]["session_subject_id"] == "subject-row-1"
    assert repo.links[0]["participant_index"] == 1
    assert queue.subject_link_depth() == 0


def test_link_waits_until_the_subject_row_exists(queue: OfflineQueue) -> None:
    repo = FakeRepo()
    publisher = EventPublisher(repo, queue)
    links = attribute_event_subjects(frame_result(snapshot(1, "t-7")), primary_tracking_id="t-7")

    publisher.publish(make_event(exam_session_id=SESSION, subject_links=links))
    assert repo.links == []
    assert queue.subject_link_depth() == 1

    # The subject is persisted a moment later: the same event gets its link.
    repo.subject_rows[(SESSION, 1)] = "subject-row-1"
    assert publisher.retry_pending_subject_links(now=future_moment()) == 1
    assert repo.links[0]["event_id"] == "event-1"
    assert queue.subject_link_depth() == 0


def test_link_is_not_written_while_the_event_is_still_queued(queue: OfflineQueue) -> None:
    repo = FakeRepo()
    repo.insert_events_fail = True
    repo.subject_rows[(SESSION, 1)] = "subject-row-1"
    # A transport failure is NOT a duplicate: the event must be queued.
    publisher = EventPublisher(repo, queue, duplicate_error=ValueError)
    links = attribute_event_subjects(frame_result(snapshot(1, "t-7")), primary_tracking_id="t-7")

    assert publisher.publish(make_event(exam_session_id=SESSION, subject_links=links)) is False
    assert publisher.retry_pending_subject_links(now=future_moment()) == 0
    assert queue.subject_link_depth() == 1

    # Once the event itself lands, the queued link becomes writable.
    repo.insert_events_fail = False
    assert publisher.retry_pending() == 1
    assert publisher.retry_pending_subject_links(now=future_moment()) == 1
    assert repo.links[0]["session_subject_id"] == "subject-row-1"


def test_duplicate_link_insert_is_treated_as_done(queue: OfflineQueue) -> None:
    class DuplicateRepo(FakeRepo):
        def insert_event_subject(self, row: dict[str, Any]) -> None:
            raise ValueError("duplicate key")

    repo = DuplicateRepo()
    repo.subject_rows[(SESSION, 1)] = "subject-row-1"
    publisher = EventPublisher(repo, queue, duplicate_error=ValueError)
    links = attribute_event_subjects(frame_result(snapshot(1, "t-7")), primary_tracking_id="t-7")

    publisher.publish(make_event(exam_session_id=SESSION, subject_links=links))
    assert queue.subject_link_depth() == 0


def test_two_participants_produce_two_stable_links(queue: OfflineQueue) -> None:
    repo = FakeRepo()
    repo.subject_rows[(SESSION, 1)] = "row-1"
    repo.subject_rows[(SESSION, 2)] = "row-2"
    publisher = EventPublisher(repo, queue)
    event = make_event(person_tracking_id="t-1")
    event.evidence = [
        EvidenceItem(
            object_id="o1",
            class_name="person",
            confidence=0.9,
            bbox=BBox(0.1, 0.1, 0.2, 0.3),
            role="person",
            tracking_id="t-2",
        )
    ]
    event.exam_session_id = SESSION
    event.subject_links = attribute_event_subjects(
        frame_result(snapshot(1, "t-1"), snapshot(2, "t-2")),
        primary_tracking_id=event.person_tracking_id,
        additional_tracking_ids=evidence_person_tracking_ids(event),
    )
    publisher.publish(event)
    assert sorted(row["participant_index"] for row in repo.links) == [1, 2]
    assert {row["session_subject_id"] for row in repo.links} == {"row-1", "row-2"}


def test_attribution_backoff_is_bounded(queue: OfflineQueue) -> None:
    repo = FakeRepo()
    publisher = EventPublisher(repo, queue)
    links = attribute_event_subjects(frame_result(snapshot(1, "t-7")), primary_tracking_id="t-7")
    publisher.publish(make_event(exam_session_id=SESSION, subject_links=links))

    # Not yet due: the retry respects the recorded backoff window.
    assert publisher.retry_pending_subject_links() == 0
    due = queue.due_subject_links(now=future_moment())
    assert len(due) == 1
    assert due[0].attempts >= 1
