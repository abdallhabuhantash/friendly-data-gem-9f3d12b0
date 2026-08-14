import { describe, expect, it } from "vitest";
import { objectCoverRect } from "@/lib/object-cover";
import {
  locateCameraSelection,
  locateHighlight,
  locateStatusMessage,
  locateSearch,
  locateTargetFor,
  locateView,
  expectedSubjectLabel,
  normalizedBox,
  parseLocateReply,
  parseLocateSearch,
  type SubjectLocateResult,
} from "@/lib/subject-locate";

const TARGET = { examSessionId: "11111111-1111-4111-8111-111111111111", subjectNumber: 7 };

const reply = (overrides: Record<string, unknown> = {}) => ({
  exam_session_id: TARGET.examSessionId,
  subject_number: 7,
  subject_label: "S007",
  locate_state: "located",
  lifecycle: "active",
  association: "confirmed",
  camera_id: "cam-1",
  last_seen_at: "2026-04-01T09:00:00Z",
  bbox: { x: 0.2, y: 0.4, width: 0.1, height: 0.3 },
  ...overrides,
});

const located = (overrides: Partial<SubjectLocateResult> = {}): SubjectLocateResult => ({
  examSessionId: TARGET.examSessionId,
  subjectNumber: 7,
  subjectLabel: "S007",
  locateState: "located",
  cameraId: "cam-1",
  lastSeenAt: "2026-04-01T09:00:00Z",
  bbox: { x: 0.2, y: 0.4, width: 0.1, height: 0.3 },
  ...overrides,
});

describe("locate reply validation", () => {
  it("accepts a proven located reply", () => {
    const parsed = parseLocateReply(reply(), TARGET);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.cameraId).toBe("cam-1");
      expect(parsed.value.bbox).toEqual({ x: 0.2, y: 0.4, width: 0.1, height: 0.3 });
    }
  });

  it("rejects a reply about a different session or subject", () => {
    expect(parseLocateReply(reply({ exam_session_id: "other" }), TARGET).ok).toBe(false);
    expect(parseLocateReply(reply({ subject_number: 8 }), TARGET).ok).toBe(false);
  });

  it("rejects a located reply without a usable position", () => {
    expect(parseLocateReply(reply({ bbox: null }), TARGET).ok).toBe(false);
    expect(parseLocateReply(reply({ camera_id: null }), TARGET).ok).toBe(false);
    expect(parseLocateReply(reply({ bbox: { x: 0.2, y: 0.4, width: 0, height: 0.3 } }), TARGET).ok)
      .toBe(false);
    expect(
      parseLocateReply(reply({ bbox: { x: 0.9, y: 0.4, width: 0.4, height: 0.3 } }), TARGET).ok,
    ).toBe(false);
  });

  it("rejects unknown states and malformed bodies", () => {
    expect(parseLocateReply(reply({ locate_state: "probably_there" }), TARGET).ok).toBe(false);
    expect(parseLocateReply(null, TARGET).ok).toBe(false);
    expect(parseLocateReply("located", TARGET).ok).toBe(false);
  });

  it("rejects, never sanitizes, a box on a non-located state", () => {
    expect(parseLocateReply(reply({ locate_state: "temporarily_lost" }), TARGET).ok).toBe(false);
    const clean = parseLocateReply(
      reply({ locate_state: "temporarily_lost", bbox: null }),
      TARGET,
    );
    expect(clean.ok).toBe(true);
    if (clean.ok) expect(clean.value.bbox).toBeNull();
  });

  it("requires the deterministic anonymous label", () => {
    expect(parseLocateReply(reply({ subject_label: "S7" }), TARGET).ok).toBe(false);
    expect(parseLocateReply(reply({ subject_label: "Ahmad" }), TARGET).ok).toBe(false);
    expect(parseLocateReply(reply({ subject_label: undefined }), TARGET).ok).toBe(false);
    expect(expectedSubjectLabel(17)).toBe("S017");
  });

  it("requires a proven ACTIVE + CONFIRMED located answer", () => {
    for (const lifecycle of ["temporarily_lost", "lost", "ended", null, undefined]) {
      expect(parseLocateReply(reply({ lifecycle }), TARGET).ok).toBe(false);
    }
    for (const association of ["provisional", "unresolved", "conflict", null, undefined]) {
      expect(parseLocateReply(reply({ association }), TARGET).ok).toBe(false);
    }
    expect(parseLocateReply(reply({ lifecycle: "asleep" }), TARGET).ok).toBe(false);
    expect(parseLocateReply(reply({ association: "probably" }), TARGET).ok).toBe(false);
  });

  it("requires a real observation timestamp for a located answer", () => {
    expect(parseLocateReply(reply({ last_seen_at: null }), TARGET).ok).toBe(false);
    expect(parseLocateReply(reply({ last_seen_at: "yesterday" }), TARGET).ok).toBe(false);
    expect(parseLocateReply(reply({ last_seen_at: 12345 }), TARGET).ok).toBe(false);
  });

  it("requires a non-empty camera id for a located answer", () => {
    expect(parseLocateReply(reply({ camera_id: "  " }), TARGET).ok).toBe(false);
  });

  it("only accepts fully normalized boxes", () => {
    expect(normalizedBox({ x: 0, y: 0, width: 1, height: 1 })).not.toBeNull();
    expect(normalizedBox({ x: -0.1, y: 0, width: 0.5, height: 0.5 })).toBeNull();
    expect(normalizedBox({ x: 0, y: 0, width: Number.NaN, height: 0.5 })).toBeNull();
    expect(normalizedBox(undefined)).toBeNull();
  });
});

describe("highlight decision", () => {
  it("highlights only the requested subject on the owning camera", () => {
    expect(locateHighlight(located(), TARGET, "cam-1")).toEqual({
      box: { x: 0.2, y: 0.4, width: 0.1, height: 0.3 },
      label: "S007",
    });
    expect(locateHighlight(located(), TARGET, "cam-2")).toBeNull();
    expect(locateHighlight(located({ subjectNumber: 8 }), TARGET, "cam-1")).toBeNull();
    expect(locateHighlight(located(), { ...TARGET, examSessionId: "x" }, "cam-1")).toBeNull();
  });

  it("never highlights an uncertain state, a missing result or no target", () => {
    expect(locateHighlight(located({ locateState: "lost", bbox: null }), TARGET, "cam-1")).toBeNull();
    expect(locateHighlight(null, TARGET, "cam-1")).toBeNull();
    expect(locateHighlight(located(), null, "cam-1")).toBeNull();
    expect(locateHighlight(located(), TARGET, null)).toBeNull();
  });
});

describe("camera selection", () => {
  it("switches only for a proven observation on a known camera", () => {
    expect(locateCameraSelection(located(), ["cam-0", "cam-1"])).toBe("cam-1");
    expect(locateCameraSelection(located(), ["cam-0"])).toBeNull();
    expect(locateCameraSelection(located({ locateState: "unresolved", bbox: null }), ["cam-1"]))
      .toBeNull();
    expect(locateCameraSelection(null, ["cam-1"])).toBeNull();
  });
});

describe("operator wording", () => {
  it("explains every non-located state without claiming a position", () => {
    for (const state of [
      "temporarily_lost",
      "lost",
      "unresolved",
      "provisional",
      "conflict",
      "ended",
      "not_armed",
      "not_found",
      "ambiguous",
      "unavailable",
    ] as const) {
      const message = locateStatusMessage(state, "S007");
      expect(message.length).toBeGreaterThan(10);
      expect(message).not.toContain("currently observed");
    }
    expect(locateStatusMessage("located", "S007")).toContain("currently observed");
  });
});

describe("locate entry points", () => {
  it("builds and parses monitoring search parameters", () => {
    expect(locateSearch(TARGET)).toEqual({
      locateSession: TARGET.examSessionId,
      locateSubject: 7,
    });
    expect(parseLocateSearch(locateSearch(TARGET))).toEqual(TARGET);
  });

  it("rejects incomplete or invalid search parameters", () => {
    expect(parseLocateSearch({})).toBeNull();
    expect(parseLocateSearch({ locateSession: "s", locateSubject: 0 })).toBeNull();
    expect(parseLocateSearch({ locateSession: "s", locateSubject: "abc" })).toBeNull();
    expect(parseLocateSearch({ locateSubject: 2 })).toBeNull();
  });

  it("offers locate only for an attributed subject", () => {
    expect(locateTargetFor({ examSessionId: "s1", subjectNumber: 3 })).toEqual({
      examSessionId: "s1",
      subjectNumber: 3,
    });
    expect(locateTargetFor({ examSessionId: null, subjectNumber: 3 })).toBeNull();
    expect(locateTargetFor({ examSessionId: "s1", subjectNumber: null })).toBeNull();
  });
});

describe("object-cover geometry", () => {
  it("maps a normalized box through the visible crop", () => {
    // 16:9 frame in a square container: cropped horizontally... no, vertically.
    const rect = objectCoverRect(
      { x: 0.5, y: 0.5, width: 0.1, height: 0.1 },
      { width: 1600, height: 900 },
      { width: 800, height: 800 },
    );
    expect(rect).not.toBeNull();
    // scale = max(0.5, 0.888) => drawn 1422x800, offsetX = -311
    expect(rect!.left).toBeCloseTo(-311.11 + 0.5 * 1422.22, 1);
    expect(rect!.top).toBeCloseTo(400, 5);
    expect(rect!.width).toBeCloseTo(142.22, 1);
    expect(rect!.height).toBeCloseTo(80, 5);
  });

  it("is an identity mapping when aspect ratios match", () => {
    const rect = objectCoverRect(
      { x: 0.25, y: 0.5, width: 0.5, height: 0.25 },
      { width: 1280, height: 720 },
      { width: 640, height: 360 },
    );
    expect(rect).toEqual({ left: 160, top: 180, width: 320, height: 90 });
  });

  it("draws nothing without both real sizes", () => {
    const box = { x: 0.1, y: 0.1, width: 0.2, height: 0.2 };
    expect(objectCoverRect(box, null, { width: 100, height: 100 })).toBeNull();
    expect(objectCoverRect(box, { width: 100, height: 100 }, null)).toBeNull();
    expect(objectCoverRect(box, { width: 0, height: 100 }, { width: 100, height: 100 })).toBeNull();
  });

  it("returns nothing for a box outside the visible crop", () => {
    expect(
      objectCoverRect(
        { x: 0.0, y: 0.0, width: 0.02, height: 0.02 },
        { width: 4000, height: 100 },
        { width: 100, height: 100 },
      ),
    ).toBeNull();
  });
});

describe("locate view: a failed poll never keeps an old highlight", () => {
  const success = { data: located(), isPending: false, isError: false, dataUpdatedAt: 1000 };

  it("draws the highlight for a fresh successful read", () => {
    const view = locateView(TARGET, success, "cam-1", ["cam-1"]);
    expect(view.highlight).toEqual({ box: located().bbox, label: "S007" });
    expect(view.cameraSelection).toBe("cam-1");
    expect(view.status).toBeNull();
    expect(view.polling).toBe(true);
  });

  it("clears the highlight when a later poll fails, even though data is cached", () => {
    const view = locateView(
      TARGET,
      { ...success, isError: true, errorUpdatedAt: 2000 },
      "cam-1",
      ["cam-1"],
    );
    expect(view.highlight).toBeNull();
    expect(view.cameraSelection).toBeNull();
    expect(view.status).toContain("could not be located");
  });

  it("clears the highlight when the failure is newer than the success", () => {
    const view = locateView(
      TARGET,
      { ...success, isError: false, errorUpdatedAt: 2000 },
      "cam-1",
      ["cam-1"],
    );
    expect(view.highlight).toBeNull();
  });

  it("keeps the highlight when the last success is newer than an older failure", () => {
    const view = locateView(
      TARGET,
      { ...success, dataUpdatedAt: 3000, errorUpdatedAt: 2000 },
      "cam-1",
      ["cam-1"],
    );
    expect(view.highlight).not.toBeNull();
  });

  it("clears the highlight while a new target is still pending", () => {
    const view = locateView(
      { ...TARGET, subjectNumber: 9 },
      { data: located(), isPending: true, isError: false },
      "cam-1",
      ["cam-1"],
    );
    expect(view.highlight).toBeNull();
    expect(view.status).toBe("Locating S009…");
  });

  it("clears the highlight for an unavailable answer", () => {
    const view = locateView(
      TARGET,
      { data: located({ locateState: "unavailable", bbox: null }), isPending: false, isError: false },
      "cam-1",
      ["cam-1"],
    );
    expect(view.highlight).toBeNull();
    expect(view.status).toContain("S007");
  });

  it("says the subject is on another camera instead of drawing it here", () => {
    const view = locateView(TARGET, success, "cam-2", ["cam-1", "cam-2"]);
    expect(view.highlight).toBeNull();
    expect(view.status).toContain("another camera");
  });

  it("stops polling and shows nothing once the locate target is cleared", () => {
    const view = locateView(null, success, "cam-1", ["cam-1"]);
    expect(view).toEqual({
      highlight: null,
      cameraSelection: null,
      status: null,
      polling: false,
    });
  });
});
