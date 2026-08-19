"""Credential resolution must survive operator formatting differences.

A missed lookup silently produces an anonymous RTSP URL, which Hikvision (and
most cameras) reject with `401 Unauthorized` on DESCRIBE. None of these tests
assert on credential values in logs.
"""

from __future__ import annotations

import json
import logging

import pytest

from app.camera.source_builder import build_rtsp_url, redact
from app.domain.models import CameraConfig, SourceType
from app.infrastructure.credential_provider import FileCredentialProvider


def _write(tmp_path, payload) -> FileCredentialProvider:
    path = tmp_path / "cameras.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    return FileCredentialProvider(path)


def test_lookup_by_host(tmp_path):
    provider = _write(tmp_path, {"192.168.1.64": {"username": "u", "password": "p"}})
    assert provider.get("c3689bab", "192.168.1.64") == ("u", "p")


@pytest.mark.parametrize(
    "key",
    [
        " 192.168.1.64 ",
        "192.168.1.64:554",
        "rtsp://192.168.1.64:554/Streaming/Channels/101",
    ],
)
def test_tolerates_key_formatting(tmp_path, key):
    provider = _write(tmp_path, {key: {"username": "u", "password": "p"}})
    assert provider.get("cam-1", "192.168.1.64") == ("u", "p")


def test_camera_id_wins_and_comments_ignored(tmp_path):
    provider = _write(
        tmp_path,
        {
            "_comment": {"username": "ignored"},
            "CAM-ID": {"username": "byid", "password": "x"},
            "192.168.1.64": {"username": "byhost", "password": "y"},
        },
    )
    assert provider.get("cam-id", "192.168.1.64") == ("byid", "x")


def test_missing_file_warns_without_crashing(tmp_path, caplog):
    provider = FileCredentialProvider(tmp_path / "absent.json")
    with caplog.at_level(logging.WARNING):
        assert provider.get("cam", "192.168.1.64") == (None, None)
    assert "credentials file not found" in caplog.text


def test_credentials_are_injected_and_redacted():
    camera = CameraConfig(
        id="cam",
        name="Exam Camera 1",
        source_type=SourceType.DIRECT_IP if hasattr(SourceType, "DIRECT_IP") else SourceType.DEMO,
        host="192.168.1.64",
        rtsp_port=554,
        stream_path="/Streaming/Channels/101",
    )
    url = build_rtsp_url(camera, username="u", password="p@ss/word")
    assert url.startswith("rtsp://u:")
    assert "192.168.1.64:554/Streaming/Channels/101" in url
    safe = redact(url)
    assert "***:***@" in safe
    assert "p@ss" not in safe
