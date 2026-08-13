/**
 * Pure grouping layer for the subject-centric exam review queue.
 *
 * Truthfulness rules enforced here:
 * - Grouping NEVER creates, guesses, repairs or changes attribution. It only
 *   groups attribution rows that already exist in the database.
 * - The grouping key is `exam_session_id + session_subject_id`. Raw tracker ids,
 *   student names, university ids, cameras, seats and positions are never used,
 *   so S017 in one exam session can never merge with S017 in another.
 * - "Pending" is derived from the Event status only (`new`, `under_review`).
 *   No review state exists per subject.
 * - One event linked to two subjects appears in both groups while remaining a
 *   single event record with one shared current status.
 */
import type { DetectionEvent, EventSubjectAttribution } from "@/types";

export interface SubjectReviewGroup {
  /** `${examSessionId}:${sessionSubjectId}` — the only grouping identity. */
  key: string;
  examSessionId: string;
  sessionSubjectId: string;
  subjectNumber: number;
  /** Anonymous monitoring label, e.g. "S017". Always shown. */
  subjectLabel: string;
  /** Current active human resolution, or null when unresolved. */
  resolution: EventSubjectAttribution["resolution"];
  /** The linked events, newest first. Same event object as the Event Log. */
  events: DetectionEvent[];
  totalCount: number;
  newCount: number;
  underReviewCount: number;
  pendingCount: number;
  confirmedCount: number;
  rejectedCount: number;
  latestDetectedAt: string | null;
  /** Newest detection time among pending events, used for ordering. */
  latestPendingAt: string | null;
  /** Distinct event types, most frequent first. */
  eventTypes: string[];
}

export const isPendingEvent = (event: DetectionEvent): boolean =>
  event.status === "new" || event.status === "under_review";

const byDetectedAtDesc = (a: DetectionEvent, b: DetectionEvent) =>
  b.detectedAt.localeCompare(a.detectedAt);

/**
 * Groups already-persisted attribution rows by subject.
 *
 * @param events events of ONE exam session (database-filtered)
 * @param attribution attribution rows keyed by event id (one batched read)
 */
export function groupSubjectReview(
  events: readonly DetectionEvent[],
  attribution: ReadonlyMap<string, readonly EventSubjectAttribution[]>,
): SubjectReviewGroup[] {
  const groups = new Map<string, SubjectReviewGroup>();
  const typeCounts = new Map<string, Map<string, number>>();

  for (const event of events) {
    for (const row of attribution.get(event.id) ?? []) {
      const key = `${row.examSessionId}:${row.sessionSubjectId}`;
      let group = groups.get(key);
      if (!group) {
        group = {
          key,
          examSessionId: row.examSessionId,
          sessionSubjectId: row.sessionSubjectId,
          subjectNumber: row.subjectNumber,
          subjectLabel: row.subjectLabel,
          resolution: row.resolution,
          events: [],
          totalCount: 0,
          newCount: 0,
          underReviewCount: 0,
          pendingCount: 0,
          confirmedCount: 0,
          rejectedCount: 0,
          latestDetectedAt: null,
          latestPendingAt: null,
          eventTypes: [],
        };
        groups.set(key, group);
        typeCounts.set(key, new Map());
      }
      // Only the CURRENT active resolution is displayed; a revoked resolution is
      // absent from the read, so it can never surface as the current student.
      if (row.resolution) group.resolution = row.resolution;
      if (!group.events.some((existing) => existing.id === event.id)) {
        group.events.push(event);
        group.totalCount += 1;
        if (event.status === "new") group.newCount += 1;
        if (event.status === "under_review") group.underReviewCount += 1;
        if (event.status === "confirmed") group.confirmedCount += 1;
        if (event.status === "rejected") group.rejectedCount += 1;
        if (isPendingEvent(event)) {
          group.pendingCount += 1;
          if (!group.latestPendingAt || event.detectedAt > group.latestPendingAt)
            group.latestPendingAt = event.detectedAt;
        }
        if (!group.latestDetectedAt || event.detectedAt > group.latestDetectedAt)
          group.latestDetectedAt = event.detectedAt;
        const counts = typeCounts.get(key)!;
        counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
      }
    }
  }

  for (const group of groups.values()) {
    group.events.sort(byDetectedAtDesc);
    group.eventTypes = [...(typeCounts.get(group.key) ?? new Map<string, number>()).entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([type]) => type);
  }

  return sortSubjectReview([...groups.values()]);
}

/**
 * Priority: subjects with NEW events, then UNDER_REVIEW, then newest pending
 * time, then S-number. Identity resolution never affects priority.
 */
export function sortSubjectReview(groups: SubjectReviewGroup[]): SubjectReviewGroup[] {
  return groups.sort((a, b) => {
    const tier = (group: SubjectReviewGroup) =>
      group.newCount > 0 ? 0 : group.underReviewCount > 0 ? 1 : 2;
    const tierDiff = tier(a) - tier(b);
    if (tierDiff !== 0) return tierDiff;
    const pending = (b.latestPendingAt ?? "").localeCompare(a.latestPendingAt ?? "");
    if (pending !== 0) return pending;
    return a.subjectNumber - b.subjectNumber || a.subjectLabel.localeCompare(b.subjectLabel);
  });
}

/**
 * Exam events that truthfully carry the exam session but have ZERO attribution
 * rows. They must stay visible and stay unattributed.
 */
export function unattributedExamEvents(
  events: readonly DetectionEvent[],
  attribution: ReadonlyMap<string, readonly EventSubjectAttribution[]>,
): DetectionEvent[] {
  return events
    .filter((event) => (attribution.get(event.id) ?? []).length === 0)
    .sort(byDetectedAtDesc);
}
