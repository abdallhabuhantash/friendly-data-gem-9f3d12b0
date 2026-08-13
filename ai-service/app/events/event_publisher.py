"""Persists confirmed events, with a durable queue behind every network call.

Publishing order: UUID -> snapshot -> upload -> insert -> notify. A failing
upload never discards a critical detection: the event is stored with
``snapshot_path = null`` and the snapshot is recorded as *pending evidence* so
a later retry can attach it to the very same event UUID.

Evidence retry safety
---------------------
An evidence retry only ever updates the ``snapshot_path`` column of one event
row (``set_event_snapshot``). It never upserts or re-inserts the row, so a
human review decision (``status``, ``reviewed_by``, ``reviewed_at``, notes)
can never be overwritten by a late-arriving snapshot upload.

Anonymous subject attribution
-----------------------------
Event -> anonymous subject links are audit facts written AFTER the event row
exists. They are queued durably by ``(exam_session_id, subject_number)``, never
by row id, because a subject may not have been persisted yet at detection time.
A missing or unresolvable subject never blocks or discards the event.

Local file ownership
--------------------
The local annotated JPEG is deleted only when no pending evidence job and no
pending notification still reference it.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)

#: Bounded backoff for evidence uploads, in seconds.
EVIDENCE_BACKOFF_STEP = 30.0
EVIDENCE_BACKOFF_MAX = 600.0


class EventPublisher:
    """Coordinates snapshot upload, Supabase insert, queueing and notification."""

    def __init__(
        self,
        repository,  # noqa: ANN001 - SupabaseRepository
        queue,  # noqa: ANN001 - OfflineQueue
        snapshots=None,  # noqa: ANN001 - SnapshotService
        notifications=None,  # noqa: ANN001 - NotificationManager
        duplicate_error: type[Exception] = Exception,
    ) -> None:
        self._repository = repository
        self._queue = queue
        self._snapshots = snapshots
        self._notifications = notifications
        self._duplicate_error = duplicate_error

    # --- public API -------------------------------------------------------
    def publish(self, event, frame=None, save_snapshot: bool = False) -> bool:
        """Publishes one confirmed event. Returns True when Supabase accepted it."""
        local_file: Optional[Path] = None
        object_path: Optional[str] = None
        if save_snapshot and frame is not None and self._snapshots is not None:
            try:
                local_file = self._snapshots.write_local(event, frame)
                if local_file is not None:
                    object_path = self._snapshots.object_path(event)
                    event.snapshot_path = self._snapshots.upload(event, local_file)
            except Exception as exc:  # isolation: inference must keep running
                logger.error("Snapshot handling failed for %s: %s", event.id, type(exc).__name__)

        row = event.to_row()
        stored = self._insert(row)
        if not stored:
            self._queue.enqueue_event(
                event.id, row, str(local_file) if local_file else None
            )
            logger.warning("Event %s queued locally for retry", event.id)
        else:
            logger.info(
                "Event %s persisted (%s, %s)", event.id, row["type"], row["association_status"]
            )
            # Stored event, failed upload: keep the evidence instead of orphaning it.
            if local_file is not None and not event.snapshot_path and object_path:
                self._queue.enqueue_evidence(event.id, object_path, str(local_file))
                logger.warning("Snapshot for event %s queued as pending evidence", event.id)
            if self._notifications is not None:
                self._notifications.enqueue(
                    event, snapshot_file=str(local_file) if local_file else None
                )

        # Attribution is queued unconditionally so an outage cannot lose the
        # audit trail; links are only sent once the event row itself exists.
        self._enqueue_subject_links(event)
        if stored:
            self.retry_pending_subject_links(limit=len(getattr(event, "subject_links", ()) or ()))

        # Cleanup only when nothing pending still needs the local file.
        if stored and local_file is not None:
            self._release_local(local_file)
        return stored

    def retry_pending(self, limit: int = 5) -> int:
        """Drains the durable event queue. Duplicates count as success."""
        sent = 0
        for pending in self._queue.due_events(limit=limit):
            row: dict[str, Any] = pending.payload
            if self._insert(row):
                self._queue.mark_event_sent(pending.event_id)
                if self._notifications is not None:
                    self._notifications.enqueue_row(row, pending.snapshot_path)
                if pending.snapshot_path:
                    self._release_local(Path(pending.snapshot_path))
                sent += 1
            else:
                self._queue.mark_event_failed(
                    pending.event_id, "insert failed", backoff_seconds=min(300, 15 * (pending.attempts + 1))
                )
        return sent

    def retry_pending_subject_links(self, limit: int = 10) -> int:
        """Drains queued event -> anonymous subject links.

        A link is attempted only when its event row already reached Supabase.
        A subject that cannot be resolved yet is retried with backoff and is
        never replaced by a guessed identity.
        """
        if limit <= 0:
            return 0
        linked = 0
        for pending in self._queue.due_subject_links(limit=limit):
            if self._queue.has_pending_event(pending.event_id):
                continue  # the event itself is still queued; try again later
            payload = pending.payload
            exam_session_id = payload.get("exam_session_id")
            subject_number = payload.get("subject_number")
            if not exam_session_id or not subject_number:
                # Nothing truthful can be written from an incomplete link.
                self._queue.mark_subject_link_sent(pending.event_id, pending.participant_index)
                continue

            subject_row_id: Optional[str] = None
            try:
                subject_row_id = self._repository.session_subject_row_id(
                    str(exam_session_id), int(subject_number)
                )
            except Exception as exc:
                logger.error(
                    "Resolving subject %s of session %s failed: %s",
                    subject_number,
                    exam_session_id,
                    type(exc).__name__,
                )

            if not subject_row_id:
                self._queue.mark_subject_link_failed(
                    pending.event_id,
                    pending.participant_index,
                    "subject row not available yet",
                    backoff_seconds=min(
                        EVIDENCE_BACKOFF_MAX, EVIDENCE_BACKOFF_STEP * (pending.attempts + 1)
                    ),
                )
                continue

            row = {
                "event_id": pending.event_id,
                "exam_session_id": str(exam_session_id),
                "session_subject_id": subject_row_id,
                "participant_index": pending.participant_index,
                "participant_role": payload.get("participant_role", "subject"),
                "link_method": payload.get("link_method", "frame_subject_ownership"),
                "link_confidence": payload.get("link_confidence"),
            }
            try:
                self._repository.insert_event_subject(row)
            except self._duplicate_error:
                # Already recorded: a retry is success, never a second link.
                pass
            except Exception as exc:
                logger.error(
                    "Subject link insert failed for event %s: %s",
                    pending.event_id,
                    type(exc).__name__,
                )
                self._queue.mark_subject_link_failed(
                    pending.event_id,
                    pending.participant_index,
                    "insert failed",
                    backoff_seconds=min(
                        EVIDENCE_BACKOFF_MAX, EVIDENCE_BACKOFF_STEP * (pending.attempts + 1)
                    ),
                )
                continue

            self._queue.mark_subject_link_sent(pending.event_id, pending.participant_index)
            linked += 1
        return linked

    def retry_pending_evidence(self, limit: int = 5) -> int:
        """Uploads snapshots for events that are already stored in Supabase.

        On success ONLY ``snapshot_path`` is updated, for the same event UUID.
        Human review fields are never touched.
        """
        if self._snapshots is None:
            return 0

        attached = 0
        for pending in self._queue.due_evidence(limit=limit):
            local_file = Path(pending.local_path)
            if not local_file.exists():
                logger.warning(
                    "Pending evidence for event %s has no local file; dropping job",
                    pending.event_id,
                )
                self._queue.mark_evidence_sent(pending.event_id)
                continue

            stored_path: Optional[str] = None
            try:
                stored_path = self._snapshots.upload_file(pending.object_path, local_file)
            except Exception as exc:
                logger.error("Evidence upload error for %s: %s", pending.event_id, type(exc).__name__)

            if not stored_path:
                self._queue.mark_evidence_failed(
                    pending.event_id,
                    "upload failed",
                    backoff_seconds=min(
                        EVIDENCE_BACKOFF_MAX, EVIDENCE_BACKOFF_STEP * (pending.attempts + 1)
                    ),
                )
                continue

            try:
                # Single-column update: review state stays exactly as the human left it.
                self._repository.set_event_snapshot(pending.event_id, stored_path)
            except Exception as exc:
                logger.error(
                    "Attaching evidence to event %s failed: %s", pending.event_id, type(exc).__name__
                )
                self._queue.mark_evidence_failed(
                    pending.event_id,
                    "update failed",
                    backoff_seconds=min(
                        EVIDENCE_BACKOFF_MAX, EVIDENCE_BACKOFF_STEP * (pending.attempts + 1)
                    ),
                )
                continue

            self._queue.mark_evidence_sent(pending.event_id)
            self._release_local(local_file)
            attached += 1
            logger.info("Evidence attached to event %s", pending.event_id)
        return attached

    # --- internals --------------------------------------------------------
    def _enqueue_subject_links(self, event) -> None:  # noqa: ANN001 - AiEvent
        """Stores this frame's attribution facts durably. Never raises."""
        links = getattr(event, "subject_links", ()) or ()
        exam_session_id = getattr(event, "exam_session_id", None)
        if not links or not exam_session_id:
            return
        for link in links:
            try:
                self._queue.enqueue_subject_link(
                    event.id,
                    link.participant_index,
                    {
                        "exam_session_id": exam_session_id,
                        "subject_number": link.subject_number,
                        "subject_label": link.subject_label,
                        "participant_role": link.participant_role,
                        "link_method": link.link_method,
                        "link_confidence": link.link_confidence,
                    },
                )
            except Exception as exc:  # attribution must never break publishing
                logger.error(
                    "Queueing subject attribution for %s failed: %s", event.id, type(exc).__name__
                )

    def _release_local(self, local_file: Path) -> None:
        """Deletes the local snapshot only when no queue still references it."""
        if self._snapshots is None:
            return
        if self._queue.references_file(str(local_file)):
            return
        self._snapshots.cleanup(local_file)

    def _insert(self, row: dict[str, Any]) -> bool:
        try:
            self._repository.insert_event(row)
            return True
        except self._duplicate_error:
            # The same UUID already exists: never re-insert or upsert, because
            # that could reset a human review decision back to `new`.
            logger.info("Event %s already persisted; treating retry as success", row.get("id"))
            return True
        except Exception as exc:
            logger.error("Event insert failed for %s: %s", row.get("id"), type(exc).__name__)
            return False
