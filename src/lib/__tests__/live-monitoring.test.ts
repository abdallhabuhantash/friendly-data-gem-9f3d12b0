import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { eventAttributionDisplay, type AttributionRead } from "@/lib/attribution-state";
import {
  alertSubjectText,
  cameraSourceLabel,
  clampWallPage,
  LIVE_ALERT_CLOCK_SKEW_TOLERANCE_MS,
  MAX_WALL_STREAMS,
  wallPageCameras,
  wallPageCount,
  isLiveAlertEligible,
  liveAlertEvent,
  LIVE_ALERT_TTL_MS,
  subjectSummaryText,
  viewportReadinessBadge,
} from "@/lib/live-monitoring";
import { streamReadiness } from "@/lib/stream-health";
import type { DetectionEvent, EventSubjectAttribution } from "@/types";

const read = (file: string) => readFileSync(file, "utf8");

const NOW = Date.parse("2026-01-01T10:00:00.000Z");

const event = (over: Partial<DetectionEvent> = {}): DetectionEvent =>
  ({
    id: "e1",
    cameraId: "c1",
    cameraName: "Hall Camera",
    examSessionId: "s1",
    type: "mobile_phone_detected",
    severity: "critical",
    status: "new",
    confidence: 0.9,
    triggerConfidence: 0.9,
    associationConfidence: 0.9,
    associationStatus: "associated",
    personTrackingId: "47",
    triggerObjectClass: "cell_phone",
    detectionDurationSeconds: 1.2,
    detectedAt: new Date(NOW - 1_000).toISOString(),
    snapshotPath: null,
    sourceMode: "live",
    ...over,
  }) as unknown as DetectionEvent;

const subject = (n: number, resolved = false): EventSubjectAttribution =>
  ({
    eventSubjectId: `es-${n}`,
    eventId: "e1",
    examSessionId: "s1",
    sessionSubjectId: `ss-${n}`,
    subjectNumber: n,
    subjectLabel: `S${String(n).padStart(3, "0")}`,
    participantIndex: n,
    participantRole: "subject",
    linkMethod: "frame_subject_ownership",
    linkConfidence: 0.9,
    linkedAt: new Date(NOW).toISOString(),
    resolution: resolved
      ? {
          id: "r1",
          rosterStudentId: "rs1",
          studentFullName: "Sara Ali",
          studentUniversityId: "20211234",
          resolvedAt: new Date(NOW).toISOString(),
          resolvedByName: "Reviewer",
        }
      : null,
  }) as EventSubjectAttribution;

const readState = (
  state: AttributionRead["state"],
  rows: EventSubjectAttribution[] = [],
): AttributionRead => ({ state, map: new Map([["e1", rows]]) });

const display = (r: AttributionRead, ev = event()) =>
  eventAttributionDisplay(r, ev.examSessionId, ev.id);

describe("live monitoring subject presentation", () => {
  it("A. shows S017 for an attributed exam event and no raw tracker id", () => {
    const text = subjectSummaryText(display(readState("ready", [subject(17)])));
    expect(text).toBe("S017");
    expect(text).not.toContain("47");
  });

  it("A2. resolved identity is secondary to the anonymous label", () => {
    expect(subjectSummaryText(display(readState("ready", [subject(17, true)])))).toBe(
      "S017 · Sara Ali · 20211234",
    );
  });

  it("B. two-subject event renders S017 ↔ S043", () => {
    expect(subjectSummaryText(display(readState("ready", [subject(17), subject(43)])))).toBe(
      "S017 ↔ S043",
    );
  });

  it("C. pending read says Loading subject…, never Unattributed", () => {
    expect(subjectSummaryText(display(readState("pending")))).toBe("Loading subject…");
  });

  it("D. failed read says Subject unavailable, never Unattributed", () => {
    expect(subjectSummaryText(display(readState("error")))).toBe("Subject unavailable");
  });

  it("E. successful zero links says Unattributed", () => {
    expect(subjectSummaryText(display(readState("ready", [])))).toBe("Unattributed");
  });

  it("F. non-exam event with a tracker id renders no identifier at all", () => {
    const ordinary = event({ examSessionId: null, personTrackingId: "47" });
    expect(subjectSummaryText(display(readState("ready", []), ordinary))).toBeNull();
  });

  it("G. alert overlay subject text uses Sxxx and never the tracking id", () => {
    expect(alertSubjectText(display(readState("ready", [subject(17)])))).toBe("SUBJECT S017");
    expect(alertSubjectText(display(readState("ready", [subject(17), subject(43)])))).toBe(
      "SUBJECTS S017 ↔ S043",
    );
    expect(alertSubjectText(display(readState("pending")))).toBe("Loading subject…");
  });
});

describe("live alert TTL", () => {
  it("H. an event inside the TTL may drive the live alert", () => {
    expect(isLiveAlertEligible(event(), "c1", NOW)).toBe(true);
    expect(liveAlertEvent([event()], "c1", NOW)?.id).toBe("e1");
  });

  it("I. the same event expires from the overlay but stays in history", () => {
    const later = NOW + LIVE_ALERT_TTL_MS + 1_000;
    expect(isLiveAlertEligible(event(), "c1", later)).toBe(false);
    expect(liveAlertEvent([event()], "c1", later)).toBeUndefined();
    // Persistence/history is untouched: the event object is unchanged.
    expect(event().status).toBe("new");
  });

  it("J. an event from another camera can never drive the live alert", () => {
    expect(isLiveAlertEligible(event({ cameraId: "c2" }), "c1", NOW)).toBe(false);
  });
});

describe("viewport LIVE truth source", () => {
  const readiness = (streaming: boolean, connected = true, offline = false) =>
    streamReadiness({
      cameraId: "c1",
      cameraOffline: offline,
      health: { ok: true, cameras: [{ id: "c1", connected, streaming }] },
      healthFailed: false,
      healthPending: false,
      healthUpdatedAt: NOW,
      now: NOW,
    });

  it("K. stalled readiness never says LIVE", () => {
    const badge = viewportReadinessBadge(readiness(false));
    expect(badge.state).toBe("stalled");
    expect(badge.text).toBe("STREAM STALLED");
    expect(badge.text).not.toContain("LIVE");
  });

  it("L. awaiting service never says LIVE", () => {
    const pending = streamReadiness({
      cameraId: "c1",
      cameraOffline: false,
      health: undefined,
      healthFailed: false,
      healthPending: true,
      healthUpdatedAt: 0,
      now: NOW,
    });
    const badge = viewportReadinessBadge(pending);
    expect(badge.text).toBe("AWAITING AI SERVICE");
    expect(badge.tone).toBe("muted");
  });

  it("M. live readiness says LIVE with a non-error tone", () => {
    const badge = viewportReadinessBadge(readiness(true));
    expect(badge.text).toBe("● LIVE");
    expect(badge.tone).toBe("success");
  });

  it("camera offline readiness reports CAMERA OFFLINE", () => {
    expect(viewportReadinessBadge(readiness(true, true, true)).text).toBe("CAMERA OFFLINE");
  });
});

describe("live monitoring source contract", () => {
  const panel = read("src/components/monitoring/LiveEventPanel.tsx");
  const overlay = read("src/components/monitoring/LiveAlertOverlay.tsx");
  const viewport = read("src/components/monitoring/MainMonitoringViewport.tsx");
  const page = read("src/routes/_authenticated/monitoring.tsx");

  it("no raw tracker identity anywhere in the Live Monitoring UI", () => {
    for (const source of [panel, overlay, viewport, page]) {
      expect(source).not.toContain("personTrackingId");
      expect(source).not.toContain("displayPersonId");
      expect(source).not.toMatch(/TRACK \$\{/);
    }
  });

  it("N. no fake detection count or non-functional AI overlay toggle", () => {
    expect(viewport).not.toContain("DETECTIONS");
    expect(viewport).not.toContain("Toggle AI overlays");
    expect(viewport).not.toContain("DetectionOverlayLayer");
    expect(page).not.toContain("detections={[]}");
    // Locate remains a real browser overlay.
    expect(viewport).toContain("SubjectLocateOverlay");
  });

  it("O. attribution for the recent event list is batched exactly once", () => {
    expect(page.match(/useEventAttribution\(/g)?.length).toBe(1);
    expect(panel).not.toContain("useEventAttribution");
  });

  it("P. realtime attribution invalidation is enabled for Live Monitoring", () => {
    expect(page).toContain("useRealtimeAttribution()");
  });

  it("Live Events keeps its own bounded scroll region", () => {
    expect(panel).toContain("min-h-0 flex-1 overflow-y-auto");
    expect(page).toContain("h-[100dvh]");
    expect(page).not.toContain("min-h-[640px]");
  });

  it("A. the wall never mounts more streams than the connection bound", () => {
    const cameras = Array.from({ length: 9 }, (_, index) => `c${index + 1}`);
    expect(MAX_WALL_STREAMS).toBe(4);
    expect(wallPageCameras(cameras, 1)).toEqual(["c1", "c2", "c3", "c4"]);
    expect(wallPageCameras(cameras, 3)).toEqual(["c9"]);
    expect(wallPageCameras(cameras, 2).length).toBeLessThanOrEqual(MAX_WALL_STREAMS);
  });

  it("B. wall pages are bounded and clamped", () => {
    expect(wallPageCount(0)).toBe(1);
    expect(wallPageCount(4)).toBe(1);
    expect(wallPageCount(5)).toBe(2);
    expect(clampWallPage(0, 9)).toBe(1);
    expect(clampWallPage(99, 9)).toBe(3);
    expect(clampWallPage(Number.NaN, 9)).toBe(1);
  });

  it("C. a shrunk camera list cannot leave the wall on a dead page", () => {
    expect(wallPageCameras(["c1", "c2"], clampWallPage(3, 2))).toEqual(["c1", "c2"]);
  });

  it("D. a clearly future-dated event cannot pin the alert overlay open", () => {
    const future = event({
      detectedAt: new Date(NOW + LIVE_ALERT_CLOCK_SKEW_TOLERANCE_MS + 5_000).toISOString(),
    });
    expect(isLiveAlertEligible(future, "c1", NOW)).toBe(false);
  });

  it("E. small clock skew is tolerated", () => {
    const skewed = event({ detectedAt: new Date(NOW + 1_000).toISOString() });
    expect(isLiveAlertEligible(skewed, "c1", NOW)).toBe(true);
  });

  it("F. camera source labels never invent NVR involvement", () => {
    expect(cameraSourceLabel("direct_camera")).toBe("DIRECT RTSP");
    expect(cameraSourceLabel("nvr_channel")).toBe("NVR CHANNEL");
    expect(cameraSourceLabel("demo")).toBe("DEMO");
  });

  it("G. no dead operator controls remain in Live Monitoring", () => {
    expect(panel).not.toContain("Filter events");
    expect(page).not.toMatch(/aria-label="(Pause|Record|Pan|Tilt|Zoom)/i);
  });

  it("H. camera sidebar states AI configuration truthfully", () => {
    const sidebar = read("src/components/monitoring/CameraSidebar.tsx");
    expect(sidebar).toContain("AI ENABLED");
    expect(sidebar).toContain("AI OFF");
    expect(sidebar).not.toContain("IP / NVR");
  });

  it("I. HUD zones stay separated so overlays cannot collide", () => {
    const viewport = read("src/components/monitoring/MainMonitoringViewport.tsx");
    expect(viewport).toContain("left-5 top-5");
    expect(viewport).toContain("right-5 top-5");
    expect(viewport).toContain("left-5 top-16");
    expect(viewport).toContain("bottom-5 left-5");
    expect(viewport).toContain("bottom-5 right-5");
  });

  it("J. main video region stays viewport-bounded", () => {
    expect(page).toContain("min-h-0 min-w-0 flex-1 flex-col p-2");
  });
});
