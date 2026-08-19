/**
 * Pure operator-truthfulness rules for Live Monitoring.
 *
 * - Raw tracker ids are internal only: nothing here ever reads
 *   `personTrackingId`. Exam identity comes exclusively from the existing
 *   anonymous subject attribution layer.
 * - A historical event may only drive the large live alert for a short TTL.
 * - Every operational LIVE claim inside the video HUD is derived from measured
 *   StreamReadiness, never from the cameras database heartbeat.
 */
import type { EventAttributionDisplay } from "@/lib/attribution-state";
import type { StreamReadiness, StreamState } from "@/lib/stream-health";
import type { DetectionEvent } from "@/types";

/** How long a detection may keep the large live-alert overlay on screen. */
export const LIVE_ALERT_TTL_MS = 10_000;

/**
 * Only a very small tolerance for a slightly fast recorder clock. A clearly
 * future-dated event fails closed instead of pinning the overlay open forever.
 */
export const LIVE_ALERT_CLOCK_SKEW_TOLERANCE_MS = 2_000;

/**
 * A live alert is temporary: the event stays in Live Events history and remains
 * reviewable, but the large overlay and alert-frame animation expire.
 */
export function isLiveAlertEligible(
  event: DetectionEvent | undefined,
  selectedCameraId: string | null | undefined,
  now: number,
): boolean {
  if (!event || !selectedCameraId) return false;
  if (event.cameraId !== selectedCameraId) return false;
  const detected = Date.parse(event.detectedAt);
  if (Number.isNaN(detected)) return false;
  const age = now - detected;
  // Future-dated beyond the allowed skew: fail closed.
  if (age < -LIVE_ALERT_CLOCK_SKEW_TOLERANCE_MS) return false;
  if (age > LIVE_ALERT_TTL_MS) return false;
  return true;
}

/** Hard bound on simultaneous browser MJPEG connections in wall mode. */
export const MAX_WALL_STREAMS = 4;

/** Number of bounded wall pages for a camera count (always at least 1). */
export function wallPageCount(cameraCount: number): number {
  if (cameraCount <= 0) return 1;
  return Math.ceil(cameraCount / MAX_WALL_STREAMS);
}

/** Clamps a requested page into the valid range for the current camera count. */
export function clampWallPage(page: number, cameraCount: number): number {
  const pages = wallPageCount(cameraCount);
  if (!Number.isFinite(page)) return 1;
  return Math.min(Math.max(Math.trunc(page), 1), pages);
}

/**
 * The cameras that may own a live MJPEG player right now. Everything outside
 * this deterministic slice is not rendered at all — never hidden-but-mounted.
 */
export function wallPageCameras<T>(cameras: readonly T[], page: number): T[] {
  const safe = clampWallPage(page, cameras.length);
  const start = (safe - 1) * MAX_WALL_STREAMS;
  return cameras.slice(start, start + MAX_WALL_STREAMS).slice(0, MAX_WALL_STREAMS);
}

/**
 * Truthful compact source label. A direct RTSP camera never claims NVR
 * involvement; NVR support remains postponed.
 */
export function cameraSourceLabel(sourceType: "direct_camera" | "nvr_channel" | "demo"): string {
  switch (sourceType) {
    case "direct_camera":
      return "DIRECT RTSP";
    case "nvr_channel":
      return "NVR CHANNEL";
    case "demo":
      return "DEMO";
  }
}


/** Newest event that may currently drive the large live alert, if any. */
export function liveAlertEvent(
  events: readonly DetectionEvent[],
  selectedCameraId: string | null | undefined,
  now: number,
): DetectionEvent | undefined {
  return events.find((event) => isLiveAlertEligible(event, selectedCameraId, now));
}

/**
 * One compact, truthful subject line for an event. Anonymous Sxxx labels are
 * canonical; a resolved student identity is secondary information only.
 */
export function subjectSummaryText(display: EventAttributionDisplay): string | null {
  switch (display.kind) {
    case "none":
      return null;
    case "loading":
      return "Loading subject…";
    case "unavailable":
      return "Subject unavailable";
    case "unattributed":
      return "Unattributed";
    case "attributed": {
      const labels = display.rows.map((row) => row.subjectLabel).filter(Boolean);
      if (labels.length === 0) return "Unattributed";
      const base = labels.join(" ↔ ");
      const single = display.rows.length === 1 ? display.rows[0] : undefined;
      if (single?.resolution)
        return `${base} · ${single.resolution.studentFullName} · ${single.resolution.studentUniversityId}`;
      return base;
    }
  }
}

/** Live-alert heading for the attributed subject(s), never a tracker id. */
export function alertSubjectText(display: EventAttributionDisplay): string | null {
  if (display.kind !== "attributed") return subjectSummaryText(display);
  const labels = display.rows.map((row) => row.subjectLabel).filter(Boolean);
  if (labels.length === 0) return "Unattributed";
  const prefix = labels.length > 1 ? "SUBJECTS" : "SUBJECT";
  return `${prefix} ${labels.join(" ↔ ")}`;
}

export type ViewportTone = "success" | "warning" | "error" | "muted";

export interface ViewportReadinessBadge {
  state: StreamState;
  text: string;
  tone: ViewportTone;
}

const BADGES: Record<StreamState, { text: string; tone: ViewportTone }> = {
  live: { text: "● LIVE", tone: "success" },
  stalled: { text: "STREAM STALLED", tone: "warning" },
  camera_offline: { text: "CAMERA OFFLINE", tone: "error" },
  awaiting_service: { text: "AWAITING AI SERVICE", tone: "muted" },
  analysis_disabled: { text: "AI ANALYSIS OFF", tone: "muted" },
  analysis_failed: { text: "AI ANALYSIS FAILING", tone: "error" },
  analysis_not_running: { text: "ANALYSIS NOT RUNNING", tone: "error" },
  analysis_slow: { text: "INFERENCE TOO SLOW", tone: "warning" },

  service_unreachable: { text: "AI SERVICE NOT REACHABLE", tone: "warning" },

};

/** The ONE LIVE claim shown inside the video HUD. */
export function viewportReadinessBadge(readiness: StreamReadiness): ViewportReadinessBadge {
  const badge = BADGES[readiness.state];
  return { state: readiness.state, text: badge.text, tone: badge.tone };
}
