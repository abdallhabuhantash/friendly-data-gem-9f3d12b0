import { describe, expect, it } from "vitest";
import {
  groupSubjectReview,
  isPendingEvent,
  unattributedExamEvents,
} from "@/lib/subject-review";
import type { DetectionEvent, EventStatus, EventSubjectAttribution } from "@/types";

const EXAM_A = "exam-a";
const EXAM_B = "exam-b";

const event = (id: string, status: EventStatus, detectedAt: string, examSessionId: string | null) =>
  ({
    id,
    type: "mobile_phone_detected",
    severity: "warning",
    status,
    cameraId: "cam-1",
    cameraName: "Hall 1",
    ruleId: "rule-1",
    confidence: 0.9,
    durationSeconds: 2,
    snapshotPath: null,
    detectedAt,
    reviewedBy: null,
    reviewedAt: null,
    note: null,
    personTrackingId: "track-77",
    triggerObjectClass: "cell phone",
    triggerConfidence: 0.9,
    associationStatus: "associated",
    associationConfidence: 0.8,
    detectionDurationSeconds: 2,
    detectionFrameCount: 6,
    evidence: [],
    sourceMode: "live",
    examSessionId,
  }) as unknown as DetectionEvent;

const link = (
  eventId: string,
  examSessionId: string,
  sessionSubjectId: string,
  subjectNumber: number,
  resolution: EventSubjectAttribution["resolution"] = null,
): EventSubjectAttribution => ({
  eventSubjectId: `${eventId}-${sessionSubjectId}`,
  eventId,
  examSessionId,
  sessionSubjectId,
  subjectNumber,
  subjectLabel: `S${String(subjectNumber).padStart(3, "0")}`,
  participantIndex: 1,
  participantRole: "subject",
  linkMethod: "frame_subject_ownership",
  linkConfidence: 0.9,
  linkedAt: "2026-08-13T10:00:00.000Z",
  resolution,
});

const mapOf = (rows: EventSubjectAttribution[]) => {
  const map = new Map<string, EventSubjectAttribution[]>();
  for (const row of rows) {
    const bucket = map.get(row.eventId);
    if (bucket) bucket.push(row);
    else map.set(row.eventId, [row]);
  }
  return map;
};

describe("groupSubjectReview", () => {
  it("collapses four events of S017 into ONE review group", () => {
    const events = [
      event("e1", "new", "2026-08-13T10:01:00Z", EXAM_A),
      event("e2", "new", "2026-08-13T10:02:00Z", EXAM_A),
      event("e3", "confirmed", "2026-08-13T10:03:00Z", EXAM_A),
      event("e4", "rejected", "2026-08-13T10:04:00Z", EXAM_A),
    ];
    const groups = groupSubjectReview(
      events,
      mapOf(events.map((e) => link(e.id, EXAM_A, "subj-17", 17))),
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.subjectLabel).toBe("S017");
    expect(groups[0]!.totalCount).toBe(4);
  });

  it("keeps S017 and S043 separate", () => {
    const events = [
      event("e1", "new", "2026-08-13T10:01:00Z", EXAM_A),
      event("e2", "new", "2026-08-13T10:02:00Z", EXAM_A),
    ];
    const groups = groupSubjectReview(
      events,
      mapOf([link("e1", EXAM_A, "subj-17", 17), link("e2", EXAM_A, "subj-43", 43)]),
    );
    expect(groups.map((g) => g.subjectLabel).sort()).toEqual(["S017", "S043"]);
  });

  it("never merges the same S-number across different exam sessions", () => {
    const events = [
      event("e1", "new", "2026-08-13T10:01:00Z", EXAM_A),
      event("e2", "new", "2026-08-13T10:02:00Z", EXAM_B),
    ];
    const groups = groupSubjectReview(
      events,
      mapOf([link("e1", EXAM_A, "subj-a17", 17), link("e2", EXAM_B, "subj-b17", 17)]),
    );
    expect(groups).toHaveLength(2);
    expect(new Set(groups.map((g) => g.examSessionId))).toEqual(new Set([EXAM_A, EXAM_B]));
  });

  it("counts new and under_review as pending, confirmed/rejected as history only", () => {
    const events = [
      event("e1", "new", "2026-08-13T10:01:00Z", EXAM_A),
      event("e2", "under_review", "2026-08-13T10:02:00Z", EXAM_A),
      event("e3", "confirmed", "2026-08-13T10:03:00Z", EXAM_A),
      event("e4", "rejected", "2026-08-13T10:04:00Z", EXAM_A),
    ];
    const [group] = groupSubjectReview(
      events,
      mapOf(events.map((e) => link(e.id, EXAM_A, "subj-17", 17))),
    );
    expect(group!.pendingCount).toBe(2);
    expect(group!.confirmedCount).toBe(1);
    expect(group!.rejectedCount).toBe(1);
    expect(group!.totalCount).toBe(4);
    expect(group!.events).toHaveLength(4);
    expect(isPendingEvent(events[2]!)).toBe(false);
  });

  it("shows one multi-subject event in both groups as the same single record", () => {
    const shared = event("e1", "new", "2026-08-13T10:01:00Z", EXAM_A);
    const groups = groupSubjectReview(
      [shared],
      mapOf([link("e1", EXAM_A, "subj-17", 17), link("e1", EXAM_A, "subj-43", 43)]),
    );
    expect(groups).toHaveLength(2);
    expect(groups[0]!.events[0]).toBe(shared);
    expect(groups[1]!.events[0]).toBe(shared);
    expect(groups.every((g) => g.totalCount === 1)).toBe(true);
  });

  it("reflects a review status change of a shared event in both groups", () => {
    const attribution = mapOf([
      link("e1", EXAM_A, "subj-17", 17),
      link("e1", EXAM_A, "subj-43", 43),
    ]);
    const confirmed = event("e1", "confirmed", "2026-08-13T10:01:00Z", EXAM_A);
    const groups = groupSubjectReview([confirmed], attribution);
    expect(groups.map((g) => g.events[0]!.status)).toEqual(["confirmed", "confirmed"]);
    expect(groups.every((g) => g.pendingCount === 0 && g.confirmedCount === 1)).toBe(true);
  });

  it("keeps the anonymous label with no resolution when identity is unresolved", () => {
    const events = [event("e1", "new", "2026-08-13T10:01:00Z", EXAM_A)];
    const [group] = groupSubjectReview(events, mapOf([link("e1", EXAM_A, "subj-17", 17)]));
    expect(group!.subjectLabel).toBe("S017");
    expect(group!.resolution).toBeNull();
  });

  it("shows the current student beside the label once resolved, and drops revoked identity", () => {
    const resolution = {
      id: "res-1",
      rosterStudentId: "stu-1",
      studentFullName: "Ahmad Ali",
      studentUniversityId: "20231234",
      resolvedAt: "2026-08-13T10:05:00Z",
      resolvedByName: "Reviewer",
    };
    const events = [event("e1", "new", "2026-08-13T10:01:00Z", EXAM_A)];
    const resolved = groupSubjectReview(
      events,
      mapOf([link("e1", EXAM_A, "subj-17", 17, resolution)]),
    );
    expect(resolved[0]!.subjectLabel).toBe("S017");
    expect(resolved[0]!.resolution?.studentFullName).toBe("Ahmad Ali");

    // After revocation the view no longer returns a resolution row.
    const revoked = groupSubjectReview(events, mapOf([link("e1", EXAM_A, "subj-17", 17, null)]));
    expect(revoked[0]!.resolution).toBeNull();
  });

  it("orders subjects with NEW events first, then under_review, then newest pending", () => {
    const events = [
      event("e1", "under_review", "2026-08-13T12:00:00Z", EXAM_A),
      event("e2", "new", "2026-08-13T10:00:00Z", EXAM_A),
      event("e3", "new", "2026-08-13T11:00:00Z", EXAM_A),
      event("e4", "confirmed", "2026-08-13T13:00:00Z", EXAM_A),
    ];
    const groups = groupSubjectReview(
      events,
      mapOf([
        link("e1", EXAM_A, "subj-1", 1),
        link("e2", EXAM_A, "subj-2", 2),
        link("e3", EXAM_A, "subj-3", 3),
        link("e4", EXAM_A, "subj-4", 4),
      ]),
    );
    expect(groups.map((g) => g.subjectLabel)).toEqual(["S003", "S002", "S001", "S004"]);
  });
});

describe("unattributedExamEvents", () => {
  it("keeps exam events with zero attribution rows visible and reviewable", () => {
    const events = [
      event("e1", "new", "2026-08-13T10:01:00Z", EXAM_A),
      event("e2", "confirmed", "2026-08-13T10:02:00Z", EXAM_A),
      event("e3", "new", "2026-08-13T10:03:00Z", EXAM_A),
    ];
    const unattributed = unattributedExamEvents(
      events,
      mapOf([link("e2", EXAM_A, "subj-17", 17)]),
    );
    expect(unattributed.map((e) => e.id)).toEqual(["e3", "e1"]);
    expect(unattributed.filter(isPendingEvent)).toHaveLength(2);
    // No subject group is invented for them.
    expect(groupSubjectReview(unattributed, new Map())).toEqual([]);
  });
});
