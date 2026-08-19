/**
 * Pure live-stream freshness contract for the web console.
 *
 * A camera may only be presented as LIVE when the AI service *measured* that it
 * is both connected and currently publishing fresh annotated frames. The 60s
 * database heartbeat is general camera health; it is never allowed to keep a
 * frozen MJPEG image on screen. Every uncertain or failed health read fails
 * closed: the previous image is dropped and no LIVE wording is shown.
 */

import type { AiEndpointReach } from "./ai-endpoint";

/** The only stream facts the browser is ever given. No keys, no URLs, no FPS. */
export interface CameraStreamHealth {
  id: string;
  connected: boolean;
  streaming: boolean;
  /**
   * Analysis switched on for this camera. Absent when the service does not
   * report it, which is never treated as "disabled".
   */
  analysisEnabled?: boolean;
  /** Failure class of the last analysis attempt, when one failed. */
  analysisError?: string | null;
  /** The camera's inference loop is actually running. Absent = not reported. */
  inferenceThreadAlive?: boolean;
  /** How long the inference call currently in flight has been running. */
  analysisStageSeconds?: number;
  /** Captured frames the inference loop has actually taken in. */
  framesSeen?: number;
  /** Frames that completed analysis and were published as annotated frames. */
  framesAnalysed?: number;
  /** Why the last captured frame was skipped, when one was. */
  analysisSkipReason?: string | null;

}

export type StreamHealthReply =
  | { ok: true; cameras: CameraStreamHealth[] }
  | { ok: false; message: string; reach?: AiEndpointReach };

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
    const analysisError = entry["analysis_error"];
    result.push({
      id,
      connected: entry["connected"] === true,
      streaming: entry["streaming"] === true,
      // An older service that does not report the field is not accused of
      // having analysis disabled; only an explicit `false` is.
      analysisEnabled: entry["ai_enabled"] !== false,
      analysisError:
        typeof analysisError === "string" && analysisError !== "" ? analysisError : null,
      // Only an explicit `false` accuses the loop of not running; an older
      // service that omits the field is left unjudged.
      inferenceThreadAlive: entry["inference_thread_alive"] !== false,
      analysisStageSeconds:
        typeof entry["analysis_stage_seconds"] === "number"
          ? (entry["analysis_stage_seconds"] as number)
          : 0,
      framesSeen: typeof entry["frames_seen"] === "number" ? (entry["frames_seen"] as number) : 0,
      framesAnalysed:
        typeof entry["frames_analysed"] === "number" ? (entry["frames_analysed"] as number) : 0,
      analysisSkipReason:
        typeof entry["analysis_skip_reason"] === "string" && entry["analysis_skip_reason"] !== ""
          ? (entry["analysis_skip_reason"] as string)
          : null,
    });
  }
  return result;
}


/** Operational state of one camera's annotated stream, as currently measured. */
export type StreamState =
  | "live"
  | "stalled"
  | "camera_offline"
  | "awaiting_service"
  /** Camera is connected but analysis is switched off for it. */
  | "analysis_disabled"
  /** Analysis is failing on the AI service, so no annotated frames exist. */
  | "analysis_failed"
  /** The camera's inference loop is not running on the AI service. */
  | "analysis_not_running"
  /** One inference call has been in flight far too long to be healthy. */
  | "analysis_slow"
  /** Frames reach the inference loop but none has ever completed analysis. */
  | "analysis_no_output"
  /** The configured AI service endpoint cannot be reached from this console. */
  | "service_unreachable";

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
  analysis_disabled: "AI ANALYSIS DISABLED FOR THIS CAMERA",
  analysis_failed: "AI ANALYSIS FAILING · SEE AI SERVICE LOGS",
  analysis_not_running: "AI ANALYSIS LOOP NOT RUNNING FOR THIS CAMERA",
  analysis_slow: "AI INFERENCE TOO SLOW · FIRST FRAME PENDING",
  analysis_no_output: "NO ANALYSED FRAMES YET · SEE AI SERVICE LOG FOR SKIP REASON",
  service_unreachable: "AI SERVICE ENDPOINT NOT REACHABLE · SEE SETTINGS",
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

/** A single in-flight inference call older than this is reported as too slow. */
export const ANALYSIS_STAGE_STUCK_SECONDS = 15;

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
  if (!input.health || !input.health.ok) {
    // A private/loopback endpoint that cannot answer is a CONFIGURATION fact,
    // not a transient wait: say so instead of implying the service will appear.
    const reach = input.health && !input.health.ok ? input.health.reach : undefined;
    if (reach === "local_only" || reach === "invalid" || reach === "unset") {
      return readiness("service_unreachable");
    }
    return readiness("awaiting_service");
  }
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
  if (entry.streaming) return readiness("live");
  // The camera IS delivering frames but no annotated frame exists. Name the
  // measured reason instead of the generic "awaiting live frames".
  if (entry.analysisEnabled === false) return readiness("analysis_disabled");
  if (entry.analysisError) return readiness("analysis_failed");
  if (entry.inferenceThreadAlive === false) return readiness("analysis_not_running");
  // A single inference call still running after this long is not a wait, it is
  // a measured performance failure the operator must be told about.
  if ((entry.analysisStageSeconds ?? 0) >= ANALYSIS_STAGE_STUCK_SECONDS) {
    return readiness("analysis_slow");
  }
  // Frames DO reach the loop but not one has ever completed: this is a measured
  // fact, not a wait, and the local service log names the skip reason.
  if ((entry.framesSeen ?? 0) > 0 && entry.framesAnalysed === 0) {
    return readiness("analysis_no_output");
  }
  return readiness("stalled");

}

/** Bounded reconnect backoff: 1s → 2s → 5s → 10s (capped). */
export const STREAM_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000] as const;

export function streamBackoffMs(attempt: number): number {
  const index = Math.min(Math.max(Math.trunc(attempt), 1), STREAM_BACKOFF_MS.length) - 1;
  return STREAM_BACKOFF_MS[index]!;
}
