"""Read-only *locate* contract for an already-existing anonymous subject.

Locate answers exactly one question about a subject the registry already owns:

    "Is S017 safely observable right now, and if so on which camera and at which
    last actually observed bounding box?"

It is pure and read-only. It never creates, renumbers, recovers, transfers or
guesses an identity, it never predicts a future position (velocity is ignored on
purpose), and it never touches roster identity. Anything less than a fully
proven observation returns **no bounding box**.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from enum import Enum
from typing import Iterable, Optional

from .geometry import BBox
from .session_subjects import (
    SubjectLifecycle,
    SubjectSnapshot,
    TrackAssociation,
    subject_label,
)


class LocateState(str, Enum):
    """Truthful outcome of one locate read."""

    #: Proven: ACTIVE + CONFIRMED + exactly one owning camera + real bbox.
    LOCATED = "located"
    TEMPORARILY_LOST = "temporarily_lost"
    LOST = "lost"
    UNRESOLVED = "unresolved"
    PROVISIONAL = "provisional"
    CONFLICT = "conflict"
    ENDED = "ended"
    #: The exam session is not armed in this runtime (or subjects are disabled).
    NOT_ARMED = "not_armed"
    #: No such subject number exists in this armed session.
    NOT_FOUND = "not_found"
    #: Impossible internal condition (same number on more than one camera).
    AMBIGUOUS = "ambiguous"
    #: Subject exists and is ACTIVE/CONFIRMED but has no observed bbox yet.
    UNAVAILABLE = "unavailable"


@dataclass(frozen=True, slots=True)
class SubjectLocation:
    """Measured, anonymous locate result. No raw tracking id, no PII."""

    exam_session_id: str
    subject_number: int
    subject_label: str
    locate_state: LocateState
    lifecycle: Optional[SubjectLifecycle] = None
    association: Optional[TrackAssociation] = None
    camera_id: Optional[str] = None
    last_seen_at: Optional[datetime] = None
    bbox: Optional[BBox] = None

    def __post_init__(self) -> None:
        if self.locate_state is LocateState.LOCATED:
            if self.bbox is None or self.camera_id is None or self.last_seen_at is None:
                raise ValueError("a located result requires camera_id, last_seen_at and bbox")
        elif self.bbox is not None:
            raise ValueError("only a located result may carry a bounding box")

    def payload(self) -> dict:
        """JSON-safe response body. Deliberately excludes tracker ids."""
        return {
            "exam_session_id": self.exam_session_id,
            "subject_number": self.subject_number,
            "subject_label": self.subject_label,
            "locate_state": self.locate_state.value,
            "lifecycle": self.lifecycle.value if self.lifecycle else None,
            "association": self.association.value if self.association else None,
            "camera_id": self.camera_id,
            "last_seen_at": self.last_seen_at.isoformat() if self.last_seen_at else None,
            "bbox": (
                None
                if self.bbox is None
                else {
                    "x": self.bbox.x,
                    "y": self.bbox.y,
                    "width": self.bbox.width,
                    "height": self.bbox.height,
                }
            ),
        }


def _observable(bbox: Optional[BBox]) -> bool:
    if bbox is None:
        return False
    values = (bbox.x, bbox.y, bbox.width, bbox.height)
    if any(value != value or value in (float("inf"), float("-inf")) for value in values):
        return False
    return bbox.width > 0.0 and bbox.height > 0.0


def locate_from_candidates(
    exam_session_id: str,
    subject_number: int,
    *,
    armed: bool,
    candidates: Iterable[tuple[str, SubjectSnapshot]] = (),
) -> SubjectLocation:
    """Pure locate decision from the current registry candidates.

    ``candidates`` are ``(camera_id, snapshot)`` pairs whose subject number
    equals ``subject_number``. More than one pair is an impossible internal
    condition: no camera is picked, the result fails closed as ``ambiguous``.
    """
    label = subject_label(subject_number)
    base = dict(
        exam_session_id=exam_session_id,
        subject_number=subject_number,
        subject_label=label,
    )
    if not armed:
        return SubjectLocation(**base, locate_state=LocateState.NOT_ARMED)
    found = tuple(candidates)
    if not found:
        return SubjectLocation(**base, locate_state=LocateState.NOT_FOUND)
    if len(found) > 1:
        return SubjectLocation(**base, locate_state=LocateState.AMBIGUOUS)
    camera_id, snapshot = found[0]
    common = dict(
        **base,
        lifecycle=snapshot.lifecycle,
        association=snapshot.association,
        camera_id=camera_id,
        last_seen_at=snapshot.last_seen_at,
    )
    if snapshot.lifecycle is SubjectLifecycle.ENDED:
        return SubjectLocation(**common, locate_state=LocateState.ENDED)
    if snapshot.lifecycle is SubjectLifecycle.TEMPORARILY_LOST:
        return SubjectLocation(**common, locate_state=LocateState.TEMPORARILY_LOST)
    if snapshot.lifecycle is SubjectLifecycle.LOST:
        return SubjectLocation(**common, locate_state=LocateState.LOST)
    if snapshot.association is TrackAssociation.CONFLICT:
        return SubjectLocation(**common, locate_state=LocateState.CONFLICT)
    if snapshot.association is TrackAssociation.PROVISIONAL:
        return SubjectLocation(**common, locate_state=LocateState.PROVISIONAL)
    if snapshot.association is not TrackAssociation.CONFIRMED:
        return SubjectLocation(**common, locate_state=LocateState.UNRESOLVED)
    bbox = snapshot.motion.last_bbox if snapshot.motion else None
    if not _observable(bbox):
        return SubjectLocation(**common, locate_state=LocateState.UNAVAILABLE)
    # Only the last ACTUALLY observed bbox — never motion.predict(...).
    return SubjectLocation(**common, locate_state=LocateState.LOCATED, bbox=bbox)


__all__ = ["LocateState", "SubjectLocation", "locate_from_candidates"]
