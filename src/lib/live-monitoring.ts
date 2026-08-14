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
  if (age > LIVE_ALERT_TTL_MS) return false;
  return true;
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
};

/** The ONE LIVE claim shown inside the video HUD. */
export function viewportReadinessBadge(readiness: StreamReadiness): ViewportReadinessBadge {
  const badge = BADGES[readiness.state];
  return { state: readiness.state, text: badge.text, tone: badge.tone };
}
