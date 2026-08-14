import { describe, expect, it } from "vitest";
import {
  canEditExamConfiguration,
  examLifecycleDescription,
  parseEndReply,
  parseStartReply,
} from "../exam-runtime-contract";

const ID = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

const startReply = (overrides: Record<string, unknown> = {}) => ({
  armed: true,
  exam_session_id: ID,
  cameras: ["cam-1"],
  started_at: "2026-05-04T08:30:00Z",
  ended_at: null,
  ...overrides,
});

const endReply = (overrides: Record<string, unknown> = {}) => ({
  armed: false,
  exam_session_id: ID,
  cameras: [],
  started_at: "2026-05-04T08:30:00Z",
  ended_at: "2026-05-04T10:00:00Z",
  ...overrides,
});

describe("start reply validation", () => {
  it("accepts a confirmed armed reply for the requested session", () => {
    const result = parseStartReply(startReply(), ID);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.armed).toBe(true);
      expect(result.value.cameras).toEqual(["cam-1"]);
      expect(result.value.startedAt).toBe("2026-05-04T08:30:00Z");
    }
  });

  it("rejects a reply for a different exam session", () => {
    expect(parseStartReply(startReply({ exam_session_id: OTHER }), ID).ok).toBe(false);
  });

  it.each([
    ["not armed", startReply({ armed: false })],
    ["armed missing", startReply({ armed: undefined })],
    ["no cameras", startReply({ cameras: [] })],
    ["missing started_at", startReply({ started_at: null })],
    ["invalid started_at", startReply({ started_at: "yesterday" })],
    ["empty started_at", startReply({ started_at: "  " })],
    ["empty body", {}],
    ["not an object", "ok"],
  ])("rejects %s instead of reporting success", (_label, raw) => {
    const result = parseStartReply(raw, ID);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/unexpected reply/i);
  });
});

describe("end reply validation", () => {
  it("accepts a confirmed disarmed reply", () => {
    const result = parseEndReply(endReply(), ID);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.armed).toBe(false);
      expect(result.value.endedAt).toBe("2026-05-04T10:00:00Z");
    }
  });

  it.each([
    ["still armed", endReply({ armed: true })],
    ["wrong session", endReply({ exam_session_id: OTHER })],
    ["missing ended_at", endReply({ ended_at: null })],
    ["invalid ended_at", endReply({ ended_at: "" })],
    ["empty body", {}],
  ])("rejects %s instead of reporting the session as ended", (_label, raw) => {
    expect(parseEndReply(raw, ID).ok).toBe(false);
  });

  it("does not require cameras for a disarmed session", () => {
    expect(parseEndReply(endReply({ cameras: [] }), ID).ok).toBe(true);
  });
});

describe("lifecycle wording", () => {
  it("never describes an ended session as not started", () => {
    const text = examLifecycleDescription("ended");
    expect(text).toMatch(/ended/i);
    expect(text).not.toMatch(/has not started/i);
  });

  it("describes ready and draft as not yet monitoring", () => {
    expect(examLifecycleDescription("ready")).toMatch(/has not started/i);
    expect(examLifecycleDescription("draft")).toMatch(/has not started/i);
  });

  it("describes an active session as armed", () => {
    expect(examLifecycleDescription("active")).toMatch(/armed/i);
  });
});

describe("configuration editing", () => {
  it("is available only before a session has run", () => {
    expect(canEditExamConfiguration("draft")).toBe(true);
    expect(canEditExamConfiguration("ready")).toBe(true);
    expect(canEditExamConfiguration("active")).toBe(false);
    expect(canEditExamConfiguration("ended")).toBe(false);
  });
});
