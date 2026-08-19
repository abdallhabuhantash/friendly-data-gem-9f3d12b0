"""Camera credential resolution.

Credentials never leave this process, never reach the API layer and are never
logged. The default source is a git-ignored local JSON file on the Windows
machine running the service.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Optional, Protocol

logger = logging.getLogger(__name__)

Credentials = tuple[Optional[str], Optional[str]]


class CredentialSource(Protocol):
    def get(self, camera_id: str, host: Optional[str] = None) -> Credentials: ...


def _normalise_key(key: str) -> str:
    """Normalises a credential key so operator formatting cannot break lookup.

    Accepts `192.168.1.64`, ` 192.168.1.64 `, `192.168.1.64:554`,
    `rtsp://192.168.1.64:554/Streaming/Channels/101` and UUIDs in any case.
    """
    value = (key or "").strip().lower()
    if "://" in value:
        value = value.split("://", 1)[1]
    if "@" in value:
        value = value.rsplit("@", 1)[1]
    value = value.split("/", 1)[0]
    if value.count(":") == 1:
        value = value.split(":", 1)[0]
    return value


class FileCredentialProvider:
    """Reads `secrets/cameras.json` and caches it until the file changes.

    Entries may be keyed by the camera's UUID (preferred, unambiguous) or by
    its host/IP, so a local operator can configure a camera before looking up
    its record id. The UUID key always wins when both are present. Keys are
    normalised (whitespace, case, optional port, optional rtsp:// prefix), so a
    slightly differently formatted key still authenticates the camera instead
    of silently producing an anonymous RTSP URL (a 401 from the camera).
    """

    def __init__(self, path: Path) -> None:
        self._path = path
        self._mtime: float | None = None
        self._data: dict[str, dict[str, str]] = {}
        self._missing_logged = False

    def _load(self) -> None:
        if not self._path.exists():
            if not self._missing_logged:
                logger.warning(
                    "Camera credentials file not found at %s; RTSP cameras that "
                    "require a username/password will fail with 401 Unauthorized",
                    self._path,
                )
                self._missing_logged = True
            self._data = {}
            self._mtime = None
            return
        mtime = self._path.stat().st_mtime
        if mtime == self._mtime:
            return
        try:
            parsed = json.loads(self._path.read_text(encoding="utf-8"))
            raw = parsed if isinstance(parsed, dict) else {}
            data: dict[str, dict[str, str]] = {}
            for key, value in raw.items():
                if not isinstance(value, dict) or str(key).startswith("_"):
                    continue
                normalised = _normalise_key(str(key))
                if normalised:
                    data[normalised] = value
            self._data = data
            self._mtime = mtime
            self._missing_logged = False
            logger.info(
                "Loaded camera credentials for %d camera(s) from %s",
                len(self._data),
                self._path,
            )
        except (OSError, json.JSONDecodeError) as exc:
            # Log the failure kind only, never the file content.
            logger.error("Unable to read camera credentials file: %s", type(exc).__name__)
            self._data = {}

    def get(self, camera_id: str, host: Optional[str] = None) -> Credentials:
        self._load()
        for candidate in (camera_id, host):
            if not candidate:
                continue
            entry = self._data.get(_normalise_key(str(candidate)))
            if isinstance(entry, dict) and (entry.get("username") or entry.get("password")):
                username = entry.get("username")
                password = entry.get("password")
                return (
                    username.strip() if isinstance(username, str) else username,
                    password if isinstance(password, str) else password,
                )
        return (None, None)




class SupabaseCredentialProvider:
    """Optional service-role-only fallback to public.camera_credentials."""

    def __init__(self, repository) -> None:  # noqa: ANN001 - avoids import cycle
        self._repository = repository

    def get(self, camera_id: str, host: Optional[str] = None) -> Credentials:
        try:
            return self._repository.camera_credentials(camera_id)
        except Exception as exc:  # pragma: no cover - network failure path
            logger.warning("Credential lookup failed for camera %s: %s", camera_id, type(exc).__name__)
            return (None, None)


class ChainedCredentialProvider:
    """Local file first, optional database fallback second."""

    def __init__(self, sources: list[CredentialSource]) -> None:
        self._sources = sources

    def get(self, camera_id: str, host: Optional[str] = None) -> Credentials:
        for source in self._sources:
            username, password = source.get(camera_id, host)
            if username or password:
                return username, password
        return (None, None)
