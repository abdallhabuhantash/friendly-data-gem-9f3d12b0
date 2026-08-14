/**
 * Pure live-stream freshness contract for the web console.
 *
 * A camera may only be presented as LIVE when the AI service *measured* that it
 * is both connected and currently publishing fresh annotated frames. The 60s
 * database heartbeat is general camera health; it is never allowed to keep a
 * frozen MJPEG image on screen. Every uncertain or failed health read fails
 * closed: the previous image is dropped and no LIVE wording is shown.
 */

/** The only stream facts the browser is ever given. No keys, no URLs, no FPS. */
export interface CameraStreamHealth {
  id: string;
  connected: boolean;
  streaming: boolean;
}

export type StreamHealthReply =
  | { ok: true; cameras: CameraStreamHealth[] }
  | { ok: false; message: string };

/**
 * Extracts the minimum safe per-camera stream facts from the authenticated
 * Python `/status` document. Anything unexpected is dropped rather than guessed.
 */
export function minimalCameraStreamHealth(body: unknown): CameraStreamHealth[] {
  if (typeof body !== "object" || body === null) return [];
  const cameras = (body as { cameras?: unknown }).cameras;
  if (!Array.isArray(cameras)) return [];
  const result: CameraStreamHealth[] = [];
  for (const raw of cameras) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    const id = entry["id"];
    if (typeof id !== "string" || id === "") continue;
    result.push({
      id,
      connected: entry["connected"] === true,
      streaming: entry["streaming"] === true,
    });
  }
  return result;
}

/** Operational state of one camera's annotated stream, as currently measured. */
export type StreamState = "live" | "stalled" | "camera_offline" | "awaiting_service";

export interface StreamReadiness {
  state: StreamState;
  /** True only when a fresh annotated stream may be mounted and called LIVE. */
  displayable: boolean;
  label: string;
}

const LABELS: Record<StreamState, string> = {
  live: "LIVE",
  stalled: "STREAM STALLED · AWAITING LIVE FRAMES",
  camera_offline: "NO SIGNAL · CAMERA OFFLINE",
  awaiting_service: "AWAITING AI SERVICE",
};

const readiness = (state: StreamState): StreamReadiness => ({
  state,
  displayable: state === "live",
  label: LABELS[state],
});

/**
 * The single readiness decision shared by the viewport, the HUD and every wall
 * tile. `health` is the shared page-level poll result, not a per-camera one.
 */
/**
 * Maximum age of the last SUCCESSFULLY COMPLETED stream-health reply that may
 * still back a LIVE claim. With a ~2s poll cadence this leaves room for one
 * missed round trip; beyond it the cached answer is treated as unknown, so a
 * permanently hung `/status` request can never preserve LIVE indefinitely.
 */
export const STREAM_HEALTH_MAX_AGE_MS = 5_000;

/**
 * The single readiness decision shared by the viewport, the HUD and every wall
 * tile. `health` is the shared page-level poll result, not a per-camera one.
 *
 * Freshness is decided by the AGE of the last completed reply, never by whether
 * a refetch happens to be in flight: a normal 2s poll must not blank a stream.
 */
export function streamReadiness(input: {
  cameraId: string;
  /** Effective (heartbeat-aware) database camera status says the camera is down. */
  cameraOffline: boolean;
  /** Latest successful reply, if any. Ignored when the current read failed. */
  health: StreamHealthReply | undefined;
  /** A failed or not-yet-completed current read must never keep a LIVE claim. */
  healthFailed: boolean;
  healthPending: boolean;
  /** When the last successful reply completed (React Query `dataUpdatedAt`). */
  healthUpdatedAt?: number;
  /** Measured "now"; injected so the deadline is deterministically testable. */
  now?: number;
}): StreamReadiness {
  if (input.cameraOffline) return readiness("camera_offline");
  if (input.healthFailed || input.healthPending) return readiness("awaiting_service");
  if (!input.health || !input.health.ok) return readiness("awaiting_service");
  const updatedAt = input.healthUpdatedAt;
  if (updatedAt !== undefined) {
    const now = input.now ?? Date.now();
    if (!(updatedAt > 0) || now - updatedAt > STREAM_HEALTH_MAX_AGE_MS) {
      return readiness("awaiting_service");
    }
  }
  const entry = input.health.cameras.find((camera) => camera.id === input.cameraId);
  if (!entry) return readiness("awaiting_service");
  if (!entry.connected) return readiness("camera_offline");
  if (!entry.streaming) return readiness("stalled");
  return readiness("live");
}

/** Bounded reconnect backoff: 1s → 2s → 5s → 10s (capped). */
export const STREAM_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000] as const;

export function streamBackoffMs(attempt: number): number {
  const index = Math.min(Math.max(Math.trunc(attempt), 1), STREAM_BACKOFF_MS.length) - 1;
  return STREAM_BACKOFF_MS[index]!;
}
