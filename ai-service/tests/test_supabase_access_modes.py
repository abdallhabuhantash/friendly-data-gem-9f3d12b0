"""Access-mode tests: service-role (self-hosted) vs managed-cloud relay.

No network and no real Supabase client is used. The direct client is injected,
and the relay's HTTP layer is replaced by a fake `requests` module, so every
assertion is about routing, authentication and error semantics only.
"""

from __future__ import annotations

import sys
import types
from datetime import datetime, timezone
from pathlib import Path

import pytest

from app.config import Settings
from app.infrastructure.relay_client import (
    RelayAuthError,
    RelayClient,
    RelayConflictError,
    RelayError,
)
from app.infrastructure.supabase_repository import DuplicateEventError, SupabaseRepository


# --- fakes ---------------------------------------------------------------
class _Response:
    def __init__(self, data):  # noqa: ANN001
        self.data = data


class _Query:
    def __init__(self, client, table, verb, payload=None):  # noqa: ANN001
        self._client = client
        self._table = table
        self._verb = verb
        self._payload = payload
        self._filters: list[tuple] = []

    def select(self, *_args, **_kwargs):  # noqa: ANN001, ANN201
        return self

    def eq(self, *args):  # noqa: ANN001, ANN201
        self._filters.append(("eq", *args))
        return self

    def neq(self, *args):  # noqa: ANN001, ANN201
        self._filters.append(("neq", *args))
        return self

    def is_(self, *args):  # noqa: ANN001, ANN201
        return self

    def limit(self, *_args):  # noqa: ANN201
        return self

    def order(self, *_args):  # noqa: ANN201
        return self

    def execute(self):  # noqa: ANN201
        self._client.calls.append((self._table, self._verb, self._payload, self._filters))
        return _Response(self._client.responses.get((self._table, self._verb), []))


class FakeClient:
    """Records every direct Data API call the repository makes."""

    def __init__(self, responses=None):  # noqa: ANN001
        self.calls: list[tuple] = []
        self.rpc_calls: list[tuple] = []
        self.storage_uploads: list[tuple] = []
        self.responses = responses or {}

    def table(self, name):  # noqa: ANN001, ANN201
        client = self

        class _Table:
            def select(self, *a, **k):  # noqa: ANN001, ANN201
                return _Query(client, name, "select")

            def insert(self, payload):  # noqa: ANN001, ANN201
                return _Query(client, name, "insert", payload)

            def update(self, payload):  # noqa: ANN001, ANN201
                return _Query(client, name, "update", payload)

            def upsert(self, payload, **_k):  # noqa: ANN001, ANN201
                return _Query(client, name, "upsert", payload)

        return _Table()

    def rpc(self, name, params):  # noqa: ANN001, ANN201
        self.rpc_calls.append((name, params))
        return _Response(7)

    @property
    def storage(self):  # noqa: ANN201
        client = self

        class _Bucket:
            def __init__(self, bucket):  # noqa: ANN001
                self._bucket = bucket

            def upload(self, path, data, options):  # noqa: ANN001, ANN201
                client.storage_uploads.append((self._bucket, path, len(data)))

        class _Storage:
            def from_(self, bucket):  # noqa: ANN001, ANN201
                return _Bucket(bucket)

        return _Storage()


class FakeRelay:
    def __init__(self, results=None, raises=None):  # noqa: ANN001
        self.calls: list[tuple] = []
        self._results = results or {}
        self._raises = raises or {}

    def call(self, operation, payload=None):  # noqa: ANN001, ANN201
        self.calls.append((operation, payload or {}))
        if operation in self._raises:
            raise self._raises[operation]
        return self._results.get(operation, {})


def cloud_repo(**kwargs):  # noqa: ANN201
    client = FakeClient(kwargs.pop("responses", None))
    relay = kwargs.pop("relay", None) or FakeRelay(kwargs.pop("results", None))
    repo = SupabaseRepository("https://example.supabase.co", client=client, relay=relay)
    return repo, client, relay


def direct_repo(responses=None):  # noqa: ANN001, ANN201
    client = FakeClient(responses)
    repo = SupabaseRepository("https://example.supabase.co", client=client)
    return repo, client


# --- 1. configuration validation ----------------------------------------
def test_service_role_mode_is_configured_and_reports_no_access_problem():
    settings = Settings(
        supabase_url="https://example.supabase.co",
        supabase_service_role_key="local-service-role",
        ai_service_key="shared",
    )
    assert settings.supabase_access_mode == "service_role"
    assert settings.service_role_mode_configured is True
    assert settings.validate_runtime() == []


def test_cloud_mode_requires_every_value_explicitly():
    settings = Settings(
        supabase_url="https://example.supabase.co",
        supabase_publishable_key="pub",
        ai_service_key="shared",
    )
    assert settings.supabase_access_mode == "unconfigured"
    problems = settings.cloud_relay_mode_problems
    assert len(problems) == 1
    assert "SUPABASE_SERVICE_ACCOUNT_EMAIL" in problems[0]
    assert "WEB_APP_BASE_URL" in problems[0]
    assert any("no usable Supabase access mode" in p for p in settings.validate_runtime())


def test_fully_configured_cloud_mode_is_usable():
    settings = Settings(
        supabase_url="https://example.supabase.co",
        supabase_publishable_key="pub",
        supabase_service_account_email="ai@example.com",
        supabase_service_account_password="placeholder",
        web_app_base_url="https://app.example.com",
        ai_service_key="shared",
    )
    assert settings.supabase_access_mode == "cloud_relay"
    assert settings.validate_runtime() == []


def test_cloud_mode_rejects_a_non_http_web_app_base_url():
    settings = Settings(
        supabase_url="https://example.supabase.co",
        supabase_publishable_key="pub",
        supabase_service_account_email="ai@example.com",
        supabase_service_account_password="placeholder",
        web_app_base_url="ftp://app.example.com",
        ai_service_key="shared",
    )
    assert settings.cloud_relay_mode_problems == ["WEB_APP_BASE_URL must be an http(s) URL"]


def test_repository_refuses_incomplete_cloud_configuration():
    with pytest.raises(ValueError):
        SupabaseRepository("https://example.supabase.co")
    with pytest.raises(ValueError):
        SupabaseRepository("https://example.supabase.co", publishable_key="pub")


# --- 2. authenticated Supabase client ------------------------------------
def test_cloud_mode_signs_the_service_account_in_for_rls_reads(monkeypatch):
    created: dict = {}

    class _Auth:
        def __init__(self):
            self.credentials = None

        def sign_in_with_password(self, credentials):  # noqa: ANN001
            self.credentials = credentials

    class _Client(FakeClient):
        def __init__(self):
            super().__init__()
            self.auth = _Auth()

    def fake_create_client(url, key):  # noqa: ANN001
        created["url"] = url
        created["key"] = key
        return _Client()

    monkeypatch.setattr(
        "app.infrastructure.supabase_repository.create_client", fake_create_client
    )
    relay = FakeRelay()
    repo = SupabaseRepository(
        "https://example.supabase.co",
        publishable_key="pub-key",
        service_account_email="ai@example.com",
        service_account_password="placeholder",
        relay=relay,
    )
    assert created == {"url": "https://example.supabase.co", "key": "pub-key"}
    assert repo.access_mode == "cloud_relay"
    assert repo._client.auth.credentials == {  # noqa: SLF001 - construction proof
        "email": "ai@example.com",
        "password": "placeholder",
    }


def test_service_role_mode_never_uses_a_relay(monkeypatch):
    monkeypatch.setattr(
        "app.infrastructure.supabase_repository.create_client",
        lambda url, key: FakeClient(),
    )
    repo = SupabaseRepository(
        "https://example.supabase.co", "service-role", relay=FakeRelay()
    )
    assert repo.access_mode == "service_role"


# --- 3. relay authentication ---------------------------------------------
def _install_fake_requests(monkeypatch, status, body="", capture=None):  # noqa: ANN001
    module = types.ModuleType("requests")

    class _Resp:
        status_code = status
        text = body

    def post(url, data=None, headers=None, timeout=None):  # noqa: ANN001
        if capture is not None:
            capture.update({"url": url, "data": data, "headers": headers, "timeout": timeout})
        return _Resp()

    module.post = post  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "requests", module)


def test_relay_sends_the_shared_key_header(monkeypatch):
    capture: dict = {}
    _install_fake_requests(monkeypatch, 200, '{"ok":true}', capture)
    relay = RelayClient("https://app.example.com/", "shared-key")
    assert relay.call("event-insert", {"row": {"id": "e1"}}) == {"ok": True}
    assert capture["url"] == "https://app.example.com/api/public/ai/event-insert"
    assert capture["headers"]["X-Service-Key"] == "shared-key"


def test_relay_rejection_is_an_auth_error(monkeypatch):
    _install_fake_requests(monkeypatch, 401, "Unauthorized")
    relay = RelayClient("https://app.example.com", "shared-key")
    with pytest.raises(RelayAuthError):
        relay.call("event-insert", {})


def test_relay_never_echoes_the_service_key_back(monkeypatch):
    _install_fake_requests(monkeypatch, 500, "failed for key shared-key")
    relay = RelayClient("https://app.example.com", "shared-key")
    with pytest.raises(RelayError) as excinfo:
        relay.call("event-insert", {})
    assert "shared-key" not in str(excinfo.value)
    assert "[redacted]" in str(excinfo.value)


def test_relay_requires_an_http_base_and_a_key():
    with pytest.raises(ValueError):
        RelayClient("ftp://app.example.com", "shared-key")
    with pytest.raises(ValueError):
        RelayClient("https://app.example.com", "")


# --- 4. HTTP 409 -> DuplicateEventError ----------------------------------
def test_relay_409_maps_to_duplicate_event_error(monkeypatch):
    _install_fake_requests(monkeypatch, 409, '{"duplicate":true}')
    relay = RelayClient("https://app.example.com", "shared-key")
    with pytest.raises(RelayConflictError):
        relay.call("event-insert", {})

    repo, _client, _relay = cloud_repo(
        relay=FakeRelay(raises={"event-insert": RelayConflictError("dup")})
    )
    with pytest.raises(DuplicateEventError):
        repo.insert_event({"id": "event-1"})


def test_relay_409_on_event_subject_maps_to_duplicate_event_error():
    repo, _client, _relay = cloud_repo(
        relay=FakeRelay(raises={"event-subject-insert": RelayConflictError("dup")})
    )
    with pytest.raises(DuplicateEventError):
        repo.insert_event_subject({"event_id": "event-1", "participant_index": 0})


def test_direct_duplicate_key_still_maps_to_duplicate_event_error():
    class _Raising(FakeClient):
        def table(self, name):  # noqa: ANN001, ANN201
            class _Table:
                def insert(self, _payload):  # noqa: ANN001, ANN201
                    class _Q:
                        def execute(self):  # noqa: ANN201
                            raise RuntimeError('duplicate key value violates 23505')

                    return _Q()

            return _Table()

    repo = SupabaseRepository("https://example.supabase.co", client=_Raising())
    with pytest.raises(DuplicateEventError):
        repo.insert_event({"id": "event-1"})


# --- 5. Group A: direct authenticated client ------------------------------
def test_group_a_config_reads_use_the_direct_client_even_in_cloud_mode():
    responses = {
        ("system_settings", "select"): [{"operation_mode": "live", "timezone": "Asia/Amman"}],
        ("cameras", "select"): [
            {
                "id": "cam-1",
                "name": "Hall A",
                "source_type": "rtsp",
                "ai_enabled": True,
                "active": True,
                "is_demo": False,
            }
        ],
        ("ai_rules", "select"): [{"id": "rule-1", "name": "Phone", "enabled": True}],
        ("ai_rule_cameras", "select"): [{"rule_id": "rule-1", "camera_id": "cam-1"}],
        ("exam_sessions", "select"): [{"id": "sess-1", "status": "active"}],
        ("exam_session_cameras", "select"): [{"camera_id": "cam-1"}],
    }
    repo, client, relay = cloud_repo(responses=responses)

    assert repo.system_config().operation_mode == "live"
    assert [c.id for c in repo.cameras("live")] == ["cam-1"]
    assert repo.rules()[0].camera_ids == ("cam-1",)
    assert repo.exam_session("sess-1")["camera_ids"] == ["cam-1"]
    assert [s["id"] for s in repo.armed_exam_sessions()] == ["sess-1"]

    tables = {call[0] for call in client.calls}
    assert tables == {
        "system_settings",
        "cameras",
        "ai_rules",
        "ai_rule_cameras",
        "exam_sessions",
        "exam_session_cameras",
    }
    assert relay.calls == []  # no Group A operation touches the relay


# --- 6. Group B: relay ----------------------------------------------------
def test_group_b_operations_all_go_through_the_relay(tmp_path: Path):
    results = {
        "camera-credentials": {"username": "op", "password": "secret"},
        "session-subject-row-id": {"id": "row-1"},
        "session-subject-rows": {"rows": [{"id": "row-1", "subject_number": 1}]},
        "session-subject-history": {"rows": [{"subject_number": 1}]},
        "allocate-subject-number": {"subject_number": 4},
        "session-subject-upsert": {"id": "row-1"},
        "exam-session-transition": {"transitioned": True},
    }
    repo, client, relay = cloud_repo(results=results)
    now = datetime(2026, 8, 18, 12, 0, tzinfo=timezone.utc)
    snapshot = tmp_path / "snap.jpg"
    snapshot.write_bytes(b"jpeg-bytes")

    assert repo.camera_credentials("cam-1") == ("op", "secret")
    repo.update_camera_runtime("cam-1", status="live", fps=12.4, heartbeat_at=now)
    repo.write_ai_health(online=True, is_demo=False, payload={"fps": 12})
    assert repo.upload_snapshot("cam-1/snap.jpg", snapshot) == "cam-1/snap.jpg"
    repo.insert_event({"id": "event-1"})
    repo.set_event_snapshot("event-1", "cam-1/snap.jpg")
    repo.insert_event_subject({"event_id": "event-1", "participant_index": 0})
    assert repo.session_subject_row_id("sess-1", 1) == "row-1"
    assert repo.existing_subject_rows("sess-1") == {1: "row-1"}
    assert repo.open_subject_history("sess-1") == [{"subject_number": 1}]
    assert repo.allocate_subject_number("sess-1") == 4
    assert (
        repo.upsert_session_subject(
            {
                "exam_session_id": "sess-1",
                "subject_number": 1,
                "lifecycle_status": "active",
                "track_association": "confirmed",
            }
        )
        == "row-1"
    )
    repo.open_subject_track(
        session_subject_id="row-1",
        exam_session_id="sess-1",
        raw_tracking_id="7",
        started_at=now,
        association_method="motion",
        association_confidence=0.9,
    )
    repo.close_subject_track(exam_session_id="sess-1", raw_tracking_id="7", ended_at=now)
    repo.set_exam_session_runtime("sess-1", status="active", started_at=now)
    assert (
        repo.transition_exam_session(
            "sess-1", expected_status="active", status="completed", ended_at=now
        )
        is True
    )

    operations = [call[0] for call in relay.calls]
    assert operations == [
        "camera-credentials",
        "camera-runtime",
        "service-health",
        "snapshot-upload",
        "event-insert",
        "event-snapshot",
        "event-subject-insert",
        "session-subject-row-id",
        "session-subject-rows",
        "session-subject-history",
        "allocate-subject-number",
        "session-subject-upsert",
        "subject-track-open",
        "subject-track-close",
        "exam-session-runtime",
        "exam-session-transition",
    ]
    # Not a single privileged operation reached the direct client.
    assert client.calls == []
    assert client.rpc_calls == []
    assert client.storage_uploads == []
    # Snapshot bytes travel base64-encoded, never as a local path.
    upload = dict(relay.calls[3][1])
    assert upload["object_path"] == "cam-1/snap.jpg"
    assert upload["data_base64"] == "anBlZy1ieXRlcw=="


def test_service_role_mode_performs_group_b_directly(tmp_path: Path):
    repo, client = direct_repo({("session_subjects", "select"): [{"id": "row-1"}]})
    snapshot = tmp_path / "snap.jpg"
    snapshot.write_bytes(b"jpeg-bytes")

    repo.insert_event({"id": "event-1"})
    repo.write_ai_health(online=True, is_demo=False, payload={})
    repo.upload_snapshot("cam-1/snap.jpg", snapshot)
    assert repo.allocate_subject_number("sess-1") == 7

    assert ("events", "insert") in {(c[0], c[1]) for c in client.calls}
    assert ("service_health", "upsert") in {(c[0], c[1]) for c in client.calls}
    assert client.storage_uploads == [("snapshots", "cam-1/snap.jpg", 10)]
    assert client.rpc_calls == [
        ("allocate_session_subject_number", {"_exam_session_id": "sess-1"})
    ]
