import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import {
  ATTRIBUTION_QUERY_KEY,
  ATTRIBUTION_REALTIME_TABLES,
  invalidateAttribution,
} from "@/lib/attribution-realtime";
import { eventAttributionDisplay, type AttributionRead } from "@/lib/attribution-state";
import { subjectReviewView } from "@/lib/subject-review";
import type { DetectionEvent, EventSubjectAttribution } from "@/types";

const event = (overrides: Partial<DetectionEvent> = {}): DetectionEvent =>
  ({
    id: "E1",
    type: "mobile_phone_detected",
    severity: "high",
    status: "new",
    cameraId: "c1",
    cameraName: "Cam 1",
    ruleId: null,
    confidence: 0.9,
    durationSeconds: 2,
    snapshotPath: null,
    detectedAt: "2026-08-13T10:00:00.000Z",
    reviewedBy: null,
    reviewedAt: null,
    note: null,
    createdAt: "2026-08-13T10:00:00.000Z",
    personTrackingId: null,
    triggerObjectClass: null,
    triggerConfidence: null,
    associationStatus: "associated",
    associationConfidence: null,
    detectionDurationSeconds: null,
    detectionFrameCount: null,
    evidence: {},
    sourceMode: "live",
    examSessionId: "X1",
    ...overrides,
  }) as DetectionEvent;

const link = (): EventSubjectAttribution =>
  ({
    eventId: "E1",
    eventSubjectId: "es1",
    examSessionId: "X1",
    sessionSubjectId: "sub-17",
    subjectNumber: 17,
    subjectLabel: "S017",
    participantIndex: 0,
    participantRole: "primary",
    linkMethod: "person_tracking_id",
    linkConfidence: null,
    resolution: null,
  }) as EventSubjectAttribution;

const read = (
  state: AttributionRead["state"],
  entries: [string, EventSubjectAttribution[]][] = [],
): AttributionRead => ({ state, map: new Map(entries) });

describe("event attribution display", () => {
  it("never shows Unattributed while the attribution read is pending", () => {
    expect(eventAttributionDisplay(read("pending"), "X1", "E1")).toEqual({ kind: "loading" });
  });

  it("never shows Unattributed when the attribution read failed", () => {
    expect(eventAttributionDisplay(read("error"), "X1", "E1")).toEqual({ kind: "unavailable" });
  });

  it("shows Unattributed only after a successful read with zero links", () => {
    expect(eventAttributionDisplay(read("ready"), "X1", "E1")).toEqual({ kind: "unattributed" });
  });

  it("shows the persisted subject when a link exists", () => {
    const display = eventAttributionDisplay(read("ready", [["E1", [link()]]]), "X1", "E1");
    expect(display.kind).toBe("attributed");
    expect(display.kind === "attributed" && display.rows[0]!.subjectLabel).toBe("S017");
  });

  it("keeps non-exam generic events identity-free in every state", () => {
    for (const state of ["pending", "error", "ready"] as const) {
      expect(eventAttributionDisplay(read(state), null, "E1")).toEqual({ kind: "none" });
    }
  });
});

describe("subject review view", () => {
  const events = [event()];

  it("does not classify exam events as unattributed while attribution loads", () => {
    expect(subjectReviewView(events, read("pending"))).toEqual({ kind: "loading" });
  });

  it("does not classify exam events as unattributed from a failed query", () => {
    expect(subjectReviewView(events, read("error")).kind).toBe("error");
  });

  it("classifies true zero-link events as unattributed once the read succeeds", () => {
    const view = subjectReviewView(events, read("ready"));
    expect(view.kind).toBe("ready");
    if (view.kind !== "ready") return;
    expect(view.groups).toHaveLength(0);
    expect(view.unattributed.map((item) => item.id)).toEqual(["E1"]);
  });

  it("late event_subject insertion moves the event from Unattributed to S017", () => {
    const before = subjectReviewView(events, read("ready"));
    expect(before.kind === "ready" && before.unattributed).toHaveLength(1);
    // T3/T4/T5: link persisted later, realtime invalidated, refetch returned it.
    const after = subjectReviewView(events, read("ready", [["E1", [link()]]]));
    expect(after.kind).toBe("ready");
    if (after.kind !== "ready") return;
    expect(after.unattributed).toHaveLength(0);
    expect(after.groups.map((group) => group.subjectLabel)).toEqual(["S017"]);
  });
});

describe("attribution realtime invalidation", () => {
  it("subscribes to exactly event_subjects and subject_identity_resolutions", () => {
    expect([...ATTRIBUTION_REALTIME_TABLES]).toEqual([
      "event_subjects",
      "subject_identity_resolutions",
    ]);
  });

  it("invalidates the batched attribution query for either table change", () => {
    const queryClient = new QueryClient();
    const spy = vi.spyOn(queryClient, "invalidateQueries").mockReturnValue(Promise.resolve());
    for (const _table of ATTRIBUTION_REALTIME_TABLES) invalidateAttribution(queryClient);
    expect(spy).toHaveBeenCalledTimes(2);
    for (const call of spy.mock.calls) {
      expect(call[0]).toEqual({ queryKey: ATTRIBUTION_QUERY_KEY });
    }
  });
});
