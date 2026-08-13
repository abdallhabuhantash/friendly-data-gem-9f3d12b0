"""Pure event -> anonymous exam subject attribution.

This layer answers exactly one question, with no I/O and no state:

    "Which anonymous exam subjects (S001, S002, ...) did the SAME analysed
    frame that produced this event prove were involved?"

Truthfulness rules, in order of importance
------------------------------------------
1. A subject is attributed ONLY when the raw tracking id carried by the event
   is, in this very frame, owned by a subject whose track association is
   CONFIRMED. An ``UNRESOLVED`` raw track never becomes an identity.
2. Nothing is inferred across frames, cameras or exam sessions. The attribution
   uses only the ``SubjectFrameResult`` of the frame that raised the event.
3. Missing attribution is a valid, honest outcome: the event remains anonymous
   rather than being attached to a guessed subject.
4. Attribution never changes detection, severity or association status. It adds
   audit facts beside the event; it never strengthens the event's claim.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Optional

from .session_subjects import (
    SubjectFrameResult,
    SubjectLifecycle,
    TrackAssociation,
)

#: How the link was established. Only frame-level ownership exists today; the
#: column is stored so a future method can never be mistaken for this one.
LINK_METHOD_FRAME_OWNERSHIP = "frame_subject_ownership"

PARTICIPANT_PRIMARY = "primary"
PARTICIPANT_COUNTERPART = "counterpart"


@dataclass(frozen=True, slots=True)
class EventSubjectLink:
    """One audited event <-> anonymous subject participation fact."""

    participant_index: int
    participant_role: str
    subject_number: int
    subject_label: str
    raw_tracking_id: str
    link_method: str = LINK_METHOD_FRAME_OWNERSHIP
    #: The association confidence the registry itself measured, when known.
    link_confidence: Optional[float] = None

    def __post_init__(self) -> None:
        if self.participant_index < 1:
            raise ValueError("participant_index must be >= 1")
        if self.subject_number < 1:
            raise ValueError("subject_number must be >= 1")
        if not self.raw_tracking_id.strip():
            raise ValueError("raw_tracking_id must be a non-blank identity")
        if self.link_confidence is not None and not 0.0 <= self.link_confidence <= 1.0:
            raise ValueError("link_confidence must be within 0..1 when present")


def evidence_person_tracking_ids(event) -> tuple[str, ...]:  # noqa: ANN001 - AiEvent
    """Person tracks an event's own evidence names, in stable order.

    NOT an attribution source. Generic evidence lists every person visible in
    the triggering frame, and "visible in the frame" is never "event
    participant". The mobile-phone engine therefore attributes solely from
    ``event.person_tracking_id``. A future multi-person engine must publish the
    participant tracks it itself proved. This helper exists only for diagnostics
    and must never be passed to ``attribute_event_subjects``.
    """

    collected: list[str] = []
    for item in getattr(event, "evidence", ()) or ():
        candidates = [getattr(item, "associated_person_tracking_id", None)]
        if getattr(item, "role", "") == "person":
            candidates.append(getattr(item, "tracking_id", None))
        for candidate in candidates:
            key = (candidate or "").strip()
            if key and key not in collected:
                collected.append(key)
    return tuple(collected)


def _owned_subjects(result: SubjectFrameResult) -> dict[str, tuple[int, str, Optional[float]]]:
    """raw tracking id -> (subject_number, label, association confidence).

    Only CONFIRMED, still-open ownership qualifies. This is the single place
    where "this raw track IS this subject" is decided.
    """
    owned: dict[str, tuple[int, str, Optional[float]]] = {}
    for snapshot in result.subjects:
        raw_id = (snapshot.active_tracking_id or "").strip()
        if not raw_id:
            continue
        if snapshot.association is not TrackAssociation.CONFIRMED:
            continue
        if snapshot.lifecycle is SubjectLifecycle.ENDED:
            continue
        owned[raw_id] = (
            snapshot.subject_number,
            snapshot.label,
            snapshot.last_association_confidence,
        )
    return owned


def attribute_event_subjects(
    result: Optional[SubjectFrameResult],
    *,
    primary_tracking_id: Optional[str],
    additional_tracking_ids: Iterable[Optional[str]] = (),
) -> tuple[EventSubjectLink, ...]:
    """Builds the audit links for one event from one frame's subject result.

    ``primary_tracking_id`` is the person track the event itself associated.
    ``additional_tracking_ids`` are further person tracks the event's evidence
    names (multi-person patterns such as a paper exchange). Duplicates and
    blank identities are ignored; ordering is deterministic: the primary track
    is always participant 1, counterparts follow in the given order.
    """
    if result is None:
        return ()
    owned = _owned_subjects(result)
    if not owned:
        return ()

    ordered: list[tuple[str, str]] = []
    seen: set[str] = set()
    for raw_id, role in [(primary_tracking_id, PARTICIPANT_PRIMARY)] + [
        (candidate, PARTICIPANT_COUNTERPART) for candidate in additional_tracking_ids
    ]:
        key = (raw_id or "").strip()
        if not key or key in seen:
            continue
        seen.add(key)
        ordered.append((key, role))

    links: list[EventSubjectLink] = []
    index = 0
    for raw_id, role in ordered:
        match = owned.get(raw_id)
        if match is None:
            # Deliberately silent: an unowned/UNRESOLVED track is not an identity.
            continue
        number, label, confidence = match
        index += 1
        links.append(
            EventSubjectLink(
                participant_index=index,
                participant_role=role,
                subject_number=number,
                subject_label=label,
                raw_tracking_id=raw_id,
                link_confidence=confidence,
            )
        )
    return tuple(links)
