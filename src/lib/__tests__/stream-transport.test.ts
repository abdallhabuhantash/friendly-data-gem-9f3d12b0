import { describe, expect, it } from "vitest";
import {
  minimalCameraStreamHealth,
  streamBackoffMs,
  streamReadiness,
  type StreamHealthReply,
} from "@/lib/stream-health";
import {
  initialStreamConnection,
  shouldOpenNow,
  streamConnectionReducer,
  type StreamConnection,
} from "@/lib/stream-connection";
import { bindUpstreamToDownstream } from "@/lib/stream-proxy";

const C1 = "11111111-1111-1111-1111-111111111111";
const C2 = "22222222-2222-2222-2222-222222222222";

const ok = (cameras: { id: string; connected: boolean; streaming: boolean }[]): StreamHealthReply =>
  ({ ok: true, cameras });

const view = (
  cameraId: string,
  health: StreamHealthReply | undefined,
  opts?: { failed?: boolean; pending?: boolean; cameraOffline?: boolean },
) =>
  streamReadiness({
    cameraId,
    cameraOffline: opts?.cameraOffline ?? false,
    health,
    healthFailed: opts?.failed ?? false,
    healthPending: opts?.pending ?? false,
  });

/**
 * Mirrors the LiveStreamPlayer effect: the shared readiness decision plus the
 * bounded retry timer, driven deterministically instead of by wall-clock time.
 */
class Player {
  state: StreamConnection;
  latestTicket: string | null;
  /** Delay of the currently armed retry timer, or null when nothing is armed. */
  armed: number | null = null;
  constructor(cameraId: string, ticket: string | null) {
    this.state = initialStreamConnection(cameraId);
    this.latestTicket = ticket;
  }
  /** One render + effect pass. */
  settle(ready: boolean, authorizationFailed = false): void {
    if (!ready || authorizationFailed) {
      this.state = streamConnectionReducer(this.state, { type: "unready" });
      this.armed = null;
      return;
    }
    if (!this.latestTicket) return;
    if (shouldOpenNow(this.state, true)) {
      this.state = streamConnectionReducer(this.state, {
        type: "open",
        ticket: this.latestTicket,
      });
      this.armed = null;
      return;
    }
    this.armed =
      this.state.retryPending && this.state.retryDelayMs !== null ? this.state.retryDelayMs : null;
  }
  fireRetryTimer(): void {
    if (this.armed === null) throw new Error("no retry timer armed");
    this.armed = null;
    if (this.latestTicket) {
      this.state = streamConnectionReducer(this.state, {
        type: "open",
        ticket: this.latestTicket,
      });
    }
  }
  load(): void {
    this.state = streamConnectionReducer(this.state, { type: "loaded" });
  }
  error(): void {
    this.state = streamConnectionReducer(this.state, { type: "error" });
  }
  switchCamera(cameraId: string): void {
    this.state = streamConnectionReducer(this.state, { type: "camera", cameraId });
    this.armed = null;
  }
  get mountedSrc(): string | null {
    return this.state.activeTicket === null
      ? null
      : `/api/stream/${this.state.cameraId}?t=${this.state.activeTicket}`;
  }
}

describe("measured stream health", () => {
  it("A: connected + streaming may be displayed and called LIVE", () => {
    const readiness = view(C1, ok([{ id: C1, connected: true, streaming: true }]));
    expect(readiness.state).toBe("live");
    expect(readiness.displayable).toBe(true);
    expect(readiness.label).toBe("LIVE");
  });

  it("B: connected but not streaming removes the image and never says LIVE", () => {
    const readiness = view(C1, ok([{ id: C1, connected: true, streaming: false }]));
    expect(readiness.state).toBe("stalled");
    expect(readiness.displayable).toBe(false);
    expect(readiness.label).not.toBe("LIVE");

    const player = new Player(C1, "t1");
    player.settle(true);
    player.load();
    expect(player.mountedSrc).not.toBeNull();
    player.settle(readiness.displayable);
    expect(player.mountedSrc).toBeNull();
  });

  it("C: a failed health read cannot keep a previously LIVE claim", () => {
    const fresh = ok([{ id: C1, connected: true, streaming: true }]);
    expect(view(C1, fresh).displayable).toBe(true);
    // Same cached data, but the CURRENT read failed: fail closed.
    const failed = view(C1, fresh, { failed: true });
    expect(failed.displayable).toBe(false);
    expect(failed.state).toBe("awaiting_service");
  });

  it("reports awaiting service while pending or unknown, and offline when disconnected", () => {
    expect(view(C1, undefined, { pending: true }).state).toBe("awaiting_service");
    expect(view(C1, { ok: false, message: "unreachable" }).state).toBe("awaiting_service");
    expect(view(C1, ok([])).state).toBe("awaiting_service");
    expect(view(C1, ok([{ id: C1, connected: false, streaming: false }])).state).toBe(
      "camera_offline",
    );
    expect(view(C1, ok([{ id: C1, connected: true, streaming: true }]), { cameraOffline: true }).state).toBe(
      "camera_offline",
    );
  });

  it("exposes only the minimum safe camera facts from /status", () => {
    const cameras = minimalCameraStreamHealth({
      version: "1.0.0",
      cameras: [
        { id: C1, name: "Hall", connected: true, streaming: true, capture_fps: 25 },
        { id: "", connected: true, streaming: true },
        "nonsense",
      ],
    });
    expect(cameras).toEqual([{ id: C1, connected: true, streaming: true }]);
    expect(minimalCameraStreamHealth(null)).toEqual([]);
  });
});

describe("bounded automatic recovery", () => {
  it("D: a transient image failure retries automatically while health stays good", () => {
    const player = new Player(C1, "t1");
    player.settle(true);
    player.load();
    player.error();
    expect(player.mountedSrc).toBeNull();
    player.settle(true);
    expect(player.armed).toBe(1_000);
    player.fireRetryTimer();
    expect(player.mountedSrc).toBe(`/api/stream/${C1}?t=t1`);
    expect(player.state.incarnation).toBe(2);
  });

  it("uses bounded backoff 1s → 2s → 5s → 10s and resets after a good frame", () => {
    expect([1, 2, 3, 4, 5, 99].map(streamBackoffMs)).toEqual([
      1_000, 2_000, 5_000, 10_000, 10_000, 10_000,
    ]);
    const player = new Player(C1, "t1");
    const delays: number[] = [];
    player.settle(true);
    for (let i = 0; i < 4; i += 1) {
      player.error();
      player.settle(true);
      delays.push(player.armed!);
      player.fireRetryTimer();
    }
    expect(delays).toEqual([1_000, 2_000, 5_000, 10_000]);
    player.load();
    player.error();
    player.settle(true);
    expect(player.armed).toBe(1_000);
  });

  it("E: the retry loop pauses when stream health goes false", () => {
    const player = new Player(C1, "t1");
    player.settle(true);
    player.error();
    player.settle(true);
    expect(player.armed).toBe(1_000);
    player.settle(false);
    expect(player.armed).toBeNull();
    expect(player.state.retryPending).toBe(false);
    expect(player.mountedSrc).toBeNull();
  });

  it("F: measured recovery reconnects promptly without any timer", () => {
    const player = new Player(C1, "t1");
    player.settle(true);
    player.error();
    player.settle(false);
    player.settle(true);
    expect(player.mountedSrc).toBe(`/api/stream/${C1}?t=t1`);
    expect(player.armed).toBeNull();
  });

  it("G: a camera switch cancels the old retry and can never replace the new camera", () => {
    const player = new Player(C1, "t1");
    player.settle(true);
    player.error();
    player.settle(true);
    expect(player.armed).toBe(1_000);
    player.switchCamera(C2);
    expect(player.armed).toBeNull();
    expect(player.state).toEqual(initialStreamConnection(C2));
    player.settle(true);
    expect(player.mountedSrc).toBe(`/api/stream/${C2}?t=t1`);
    expect(() => player.fireRetryTimer()).toThrow();
    expect(player.state.cameraId).toBe(C2);
  });
});

describe("ticket lifecycle", () => {
  it("H: a background ticket renewal does not change a healthy image src", () => {
    const player = new Player(C1, "t1");
    player.settle(true);
    player.load();
    const before = player.mountedSrc;
    player.latestTicket = "t2-renewed";
    player.settle(true);
    player.settle(true);
    expect(player.mountedSrc).toBe(before);
    expect(player.state.incarnation).toBe(1);
  });

  it("I: the next incarnation uses the newest renewed ticket", () => {
    const player = new Player(C1, "t1");
    player.settle(true);
    player.load();
    player.latestTicket = "t2-renewed";
    player.error();
    player.settle(true);
    player.fireRetryTimer();
    expect(player.mountedSrc).toBe(`/api/stream/${C1}?t=t2-renewed`);
  });

  it("J: an authorization renewal failure fails closed", () => {
    const player = new Player(C1, "t1");
    player.settle(true);
    player.load();
    player.settle(true, true);
    expect(player.mountedSrc).toBeNull();
    expect(player.state.retryPending).toBe(false);
  });
});

describe("proxy cancellation", () => {
  const fakeSignal = () => {
    const listeners: (() => void)[] = [];
    return {
      aborted: false,
      addEventListener(_type: "abort", listener: () => void) {
        listeners.push(listener);
      },
      abort() {
        this.aborted = true;
        listeners.forEach((listener) => listener());
      },
    };
  };

  it("K: a downstream abort cancels the upstream body", () => {
    let cancelled = false;
    const signal = fakeSignal();
    const decision = bindUpstreamToDownstream(
      {
        ok: true,
        contentType: "multipart/x-mixed-replace; boundary=frame",
        body: {
          cancel: async () => {
            cancelled = true;
          },
        },
      },
      signal,
    );
    expect(decision).toEqual({
      kind: "stream",
      contentType: "multipart/x-mixed-replace; boundary=frame",
    });
    expect(cancelled).toBe(false);
    signal.abort();
    expect(cancelled).toBe(true);
  });

  it("cancels immediately when the downstream request is already gone", () => {
    let cancelled = false;
    const signal = { ...fakeSignal(), aborted: true };
    const decision = bindUpstreamToDownstream(
      {
        ok: true,
        contentType: null,
        body: {
          cancel: async () => {
            cancelled = true;
          },
        },
      },
      signal,
    );
    expect(decision.kind).toBe("cancelled");
    expect(cancelled).toBe(true);
  });

  it("treats a missing or failed upstream as unavailable", () => {
    const signal = fakeSignal();
    expect(bindUpstreamToDownstream({ ok: true, contentType: null, body: null }, signal).kind).toBe(
      "unavailable",
    );
    expect(
      bindUpstreamToDownstream(
        { ok: false, contentType: null, body: { cancel: async () => undefined } },
        signal,
      ).kind,
    ).toBe("unavailable",
    );
  });
});

describe("camera wall and overlay hygiene", () => {
  it("L: every tile decides from ONE shared health result", () => {
    const shared = ok([
      { id: C1, connected: true, streaming: true },
      { id: C2, connected: true, streaming: false },
    ]);
    const decide = (cameraId: string) => view(cameraId, shared);
    expect(decide(C1).displayable).toBe(true);
    // The stalled tile clears only itself.
    expect(decide(C2).displayable).toBe(false);
    expect(decide(C1).displayable).toBe(true);
  });

  it("M: losing the stream drops the mounted image, so no stale size or locate box survives", () => {
    const player = new Player(C1, "t1");
    let imageSize: { width: number; height: number } | null = null;
    const sync = () => {
      if (player.mountedSrc === null) imageSize = null;
    };
    player.settle(true);
    player.load();
    imageSize = { width: 1280, height: 720 };
    player.settle(view(C1, ok([{ id: C1, connected: true, streaming: false }])).displayable);
    sync();
    expect(player.mountedSrc).toBeNull();
    expect(imageSize).toBeNull();
  });
});
