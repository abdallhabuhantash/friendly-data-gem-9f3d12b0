"""HTTPS relay to the web app's privileged AI endpoints.

Managed Lovable Cloud never exposes a service-role key, so privileged writes
(Group B) are performed by the web app on the service's behalf. This client is
the ONLY place that talks to that relay. The shared AI_SERVICE_KEY is sent in
the `X-Service-Key` header and is never logged, echoed or returned.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Optional

logger = logging.getLogger(__name__)


class RelayError(RuntimeError):
    """The relay could not perform the operation. Nothing is assumed done."""


class RelayAuthError(RelayError):
    """The relay rejected the shared service key (401/403)."""


class RelayConflictError(RelayError):
    """The relay reported a uniqueness conflict (409): already persisted."""


class RelayClient:
    """Calls `<base>/api/public/ai/<operation>` with a JSON payload."""

    def __init__(self, base_url: str, service_key: str, *, timeout: float = 15.0) -> None:
        base = str(base_url or "").strip().rstrip("/")
        if not (base.startswith("http://") or base.startswith("https://")):
            raise ValueError("relay base URL must be an http(s) URL")
        if not str(service_key or "").strip():
            raise ValueError("relay service key is required")
        self._base = base
        self._service_key = str(service_key)
        self._timeout = float(timeout)

    @property
    def base_url(self) -> str:
        return self._base

    def call(self, operation: str, payload: Optional[dict[str, Any]] = None) -> Any:
        import requests  # imported lazily so pure-logic tests need no HTTP stack

        url = f"{self._base}/api/public/ai/{operation}"
        try:
            response = requests.post(
                url,
                data=json.dumps(payload or {}),
                headers={
                    "Content-Type": "application/json",
                    "X-Service-Key": self._service_key,
                },
                timeout=self._timeout,
            )
        except Exception as exc:  # network failure: truthful, retryable failure
            raise RelayError(f"relay request to {operation} failed") from exc

        status = int(getattr(response, "status_code", 0))
        text = ""
        try:
            text = response.text or ""
        except Exception:  # pragma: no cover - defensive
            text = ""
        # The shared key must never travel back out of this process.
        detail = text.replace(self._service_key, "[redacted]")[:400]

        if status in (401, 403):
            raise RelayAuthError(f"relay rejected the service key for {operation}")
        if status == 409:
            raise RelayConflictError(detail or operation)
        if status < 200 or status >= 300:
            raise RelayError(f"relay {operation} returned {status}: {detail}")
        if not text.strip():
            return {}
        try:
            return json.loads(text)
        except ValueError as exc:
            raise RelayError(f"relay {operation} returned a non-JSON body") from exc
