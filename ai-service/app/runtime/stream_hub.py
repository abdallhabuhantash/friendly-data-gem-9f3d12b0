"""In-memory latest annotated frame per camera.

All MJPEG viewers share the single AI inference result. A browser viewer never
starts a second inference loop, and no placeholder frame is ever produced in
live mode.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from typing import Optional


@dataclass
class AnnotatedFrame:
    jpeg: bytes
    created_at: float
    sequence: int = 0


class StreamHub:
    """Thread-safe holder for the newest annotated JPEG of each camera."""

    def __init__(self, max_age_seconds: float = 5.0) -> None:
        self._frames: dict[str, AnnotatedFrame] = {}
        self._lock = threading.Lock()
        self._max_age = max_age_seconds
        self._sequences: dict[str, int] = {}

    def publish(self, camera_id: str, jpeg: bytes) -> None:
        with self._lock:
            sequence = self._sequences.get(camera_id, 0) + 1
            self._sequences[camera_id] = sequence
            self._frames[camera_id] = AnnotatedFrame(jpeg, time.monotonic(), sequence)

    def _current(self, camera_id: str) -> Optional[AnnotatedFrame]:
        with self._lock:
            frame = self._frames.get(camera_id)
        if frame is None:
            return None
        if (time.monotonic() - frame.created_at) > self._max_age:
            return None
        return frame

    def latest(self, camera_id: str) -> Optional[bytes]:
        frame = self._current(camera_id)
        return None if frame is None else frame.jpeg

    def latest_with_sequence(self, camera_id: str) -> tuple[Optional[bytes], int]:
        """Newest frame plus its publish sequence.

        Viewers use the sequence to send each annotated frame at most once: a
        repeated frame would only waste bandwidth and grow transport latency.
        """
        frame = self._current(camera_id)
        if frame is None:
            with self._lock:
                return None, self._sequences.get(camera_id, 0)
        return frame.jpeg, frame.sequence

    def has(self, camera_id: str) -> bool:
        return self.latest(camera_id) is not None

    def drop(self, camera_id: str) -> None:
        with self._lock:
            self._frames.pop(camera_id, None)
