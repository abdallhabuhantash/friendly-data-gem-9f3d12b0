"""Deterministic proof for the human-facing live annotation contract.

Raw tracker ids are internal only: they may never appear in an operator-facing
caption, live or in a stored evidence snapshot.
"""

from __future__ import annotations

import inspect

from app.domain.geometry import BBox
from app.domain.models import (
    AssociationResult,
    AssociationStatus,
    CLASS_PERSON,
    CLASS_PHONE,
    Detection,
)
from app.events.snapshot_service import (
    UNRESOLVED_LABEL,
    annotate_frame,
    person_caption,
    phone_caption,
)
from app.runtime import orchestrator as orchestrator_module

RAW_TRACK = "47"


def person(tracking_id: str = RAW_TRACK, confidence: float = 0.92) -> Detection:
    return Detection(
        class_name=CLASS_PERSON,
        confidence=confidence,
        bbox=BBox(0.1, 0.1, 0.3, 0.6),
        tracking_id=tracking_id,
    )


def phone(confidence: float = 0.94) -> Detection:
    return Detection(
        class_name=CLASS_PHONE,
        confidence=confidence,
        bbox=BBox(0.2, 0.3, 0.06, 0.08),
        tracking_id="p9",
    )


def association(status: AssociationStatus, confidence: float = 0.88) -> AssociationResult:
    return AssociationResult(
        status=status,
        person_tracking_id=RAW_TRACK if status is not AssociationStatus.UNASSOCIATED else None,
        confidence=confidence if status is not AssociationStatus.UNASSOCIATED else None,
    )


# --- A: ordinary monitoring -------------------------------------------------
def test_non_exam_person_caption_has_no_raw_tracker_id() -> None:
    caption = person_caption(person(), None)
    assert caption == "PERSON 92%"
    assert RAW_TRACK not in caption


# --- B: armed exam, owned track --------------------------------------------
def test_armed_owned_track_renders_subject_number_only() -> None:
    caption = person_caption(person(), {RAW_TRACK: "S017"})
    assert "S017" in caption
    assert RAW_TRACK not in caption


# --- C: armed exam, unowned track ------------------------------------------
def test_armed_unowned_track_renders_unresolved() -> None:
    caption = person_caption(person(), {"99": "S001"})
    assert UNRESOLVED_LABEL in caption
    assert RAW_TRACK not in caption


# --- D: armed exam, empty mapping ------------------------------------------
def test_armed_empty_mapping_never_falls_back_to_raw_ids() -> None:
    caption = person_caption(person(), {})
    assert caption.startswith(UNRESOLVED_LABEL)
    assert RAW_TRACK not in caption


# --- E/F/G/H: phone captions -----------------------------------------------
def test_associated_phone_resolves_same_frame_subject() -> None:
    caption = phone_caption(phone(), association(AssociationStatus.ASSOCIATED), {RAW_TRACK: "S017"})
    assert caption == "PHONE 94% -> S017"
    assert RAW_TRACK not in caption


def test_associated_phone_with_unresolved_subject() -> None:
    caption = phone_caption(phone(), association(AssociationStatus.ASSOCIATED), {})
    assert caption == f"PHONE 94% -> {UNRESOLVED_LABEL}"
    assert RAW_TRACK not in caption


def test_associated_phone_outside_exam_hides_raw_tracker() -> None:
    caption = phone_caption(phone(), association(AssociationStatus.ASSOCIATED), None)
    assert caption == "PHONE 94% - ASSOCIATED"
    assert RAW_TRACK not in caption


def test_uncertain_association_never_guesses_a_subject() -> None:
    caption = phone_caption(
        phone(), association(AssociationStatus.UNCERTAIN), {RAW_TRACK: "S017"}
    )
    assert caption == "PHONE 94% - ASSOCIATION UNCERTAIN"
    assert "S017" not in caption
    assert RAW_TRACK not in caption


def test_unassociated_phone_caption_is_bare() -> None:
    caption = phone_caption(phone(), association(AssociationStatus.UNASSOCIATED), {})
    assert caption == "PHONE 94%"


# --- I: fail closed on subject-processing failure ---------------------------
def test_missing_subject_result_cannot_reuse_previous_labels() -> None:
    """`None` mapping means the renderer claims no anonymous identity at all."""
    assert person_caption(person(), None) == "PERSON 92%"
    source = inspect.getsource(orchestrator_module.Orchestrator._process_frame)
    # The per-frame mapping starts at None and is only populated from THIS
    # frame's subject result, so a failure cannot leak a stale Sxxx.
    assert "subject_labels: Optional[dict[str, str]] = None" in source
    assert "subject_labels = dict(subject_result.labels)" in source


# --- J: one renderer for stream and evidence snapshot -----------------------
def test_stream_and_snapshot_share_the_same_renderer() -> None:
    source = inspect.getsource(orchestrator_module.Orchestrator._process_frame)
    assert source.count("annotate_frame(") == 1
    assert "self.stream_hub.publish(camera.id, jpeg)" in source
    assert "frame=annotated" in source


def test_annotate_frame_accepts_the_armed_distinction() -> None:
    signature = inspect.signature(annotate_frame)
    assert signature.parameters["subject_labels"].default is None
