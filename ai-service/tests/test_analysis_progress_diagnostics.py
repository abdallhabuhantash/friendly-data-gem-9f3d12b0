"""Measured analysis-progress diagnostics of one camera's inference loop.

These facts are the difference between "the loop never ran", "every frame was
skipped (and why)" and "one inference call is still in flight". They are counted
from real events only, and contain no image data, URL or credential.
"""

from __future__ import annotations

import threading
import time
from types import SimpleNamespace

from app.runtime.orchestrator import Orchestrator

CAM = "11111111-1111-4111-8111-111111111111"


def stub(**overrides) -> SimpleNamespace:
    base = dict(
        _threads={},
        _frames_seen={},
        _frames_analysed={},
        _last_analysis_at={},
        _skip_reason={},
        _analysis_started_at={},
        _stall_logged_at={},
    )
    base.update(overrides)
    return SimpleNamespace(**base)


def diagnostics(host: SimpleNamespace) -> dict:
    return Orchestrator._camera_analysis_diagnostics(host, CAM)


def test_no_inference_thread_is_reported_as_not_running():
    result = diagnostics(stub())
    assert result["inference_thread_alive"] is False
    assert result["frames_seen"] == 0
    assert result["frames_analysed"] == 0
    assert result["analysis_stage"] == "idle"
    assert result["last_analysis_age_seconds"] is None


def test_a_living_thread_is_reported_as_running():
    thread = threading.Thread(target=lambda: time.sleep(0.5), daemon=True)
    thread.start()
    try:
        result = diagnostics(stub(_threads={CAM: thread}))
        assert result["inference_thread_alive"] is True
    finally:
        thread.join(timeout=2.0)


def test_skip_reason_and_counters_are_reported_verbatim():
    result = diagnostics(
        stub(
            _frames_seen={CAM: 120},
            _frames_analysed={CAM: 0},
            _skip_reason={CAM: "duplicate_captured_frame"},
        )
    )
    assert result["frames_seen"] == 120
    assert result["frames_analysed"] == 0
    assert result["analysis_skip_reason"] == "duplicate_captured_frame"


def test_in_flight_inference_reports_its_real_elapsed_time():
    started = time.monotonic() - 12.0
    result = diagnostics(stub(_analysis_started_at={CAM: started}))
    assert result["analysis_stage"] == "detecting"
    assert result["analysis_stage_seconds"] >= 11.5


def test_last_analysis_age_is_measured_not_assumed():
    result = diagnostics(stub(_last_analysis_at={CAM: time.monotonic() - 3.0}))
    assert result["analysis_stage"] == "idle"
    assert 2.5 <= result["last_analysis_age_seconds"] <= 4.0


def test_diagnostics_never_leak_anything_but_counters():
    result = diagnostics(stub(_frames_seen={CAM: 1}))
    assert set(result) == {
        "inference_thread_alive",
        "frames_seen",
        "frames_analysed",
        "analysis_skip_reason",
        "analysis_stage",
        "analysis_stage_seconds",
        "last_analysis_age_seconds",
    }


def test_inference_loop_survives_a_temporarily_missing_runtime_snapshot():
    """A camera that is still ACTIVE must not lose its inference loop.

    Exiting on a transient missing snapshot left a connected camera with no
    inference at all until the next configuration refresh, which presented as
    "camera online, analysis FPS 0.0" with no explanation.
    """
    calls = {"n": 0}

    class Cameras:
        active = [CAM]

        def snapshot(self, camera_id: str):
            calls["n"] += 1
            return None

    stop = threading.Event()

    host = SimpleNamespace(
        settings=SimpleNamespace(inference_max_fps=10.0),
        cameras=Cameras(),
        _stop=stop,
        _skip_reason={},
        _frames_seen={},
        _frames_analysed={},
        _stall_logged_at={},
        _analysis_started_at={},
        _seen_generation={},
    )
    host._maybe_log_stall = lambda *_: None

    worker = threading.Thread(target=Orchestrator._inference_loop, args=(host, CAM), daemon=True)
    worker.start()
    time.sleep(0.5)
    assert worker.is_alive(), "loop exited while the camera was still active"
    assert host._skip_reason[CAM] == "awaiting_camera_runtime"
    stop.set()
    worker.join(timeout=2.0)
    assert calls["n"] > 1


def test_inference_loop_exits_when_the_camera_is_no_longer_active():
    class Cameras:
        active: list[str] = []

        def snapshot(self, camera_id: str):
            return None

    host = SimpleNamespace(
        settings=SimpleNamespace(inference_max_fps=10.0),
        cameras=Cameras(),
        _stop=threading.Event(),
        _skip_reason={},
        _seen_generation={},
    )
    Orchestrator._inference_loop(host, CAM)  # returns instead of spinning


def test_dead_inference_thread_is_restarted_by_supervision():
    dead = threading.Thread(target=lambda: None)
    dead.start()
    dead.join()

    class Cameras:
        active = [CAM]

    host = SimpleNamespace(cameras=Cameras(), _threads={CAM: dead}, _inference_loop=lambda _: None)
    Orchestrator._ensure_inference_threads(host)
    assert host._threads[CAM] is not dead
