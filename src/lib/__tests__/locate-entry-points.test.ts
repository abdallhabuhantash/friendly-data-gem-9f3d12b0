import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { expectedSubjectLabel, parseLocateSearch } from "@/lib/subject-locate";

const read = (path: string) => readFileSync(path, "utf8");

/**
 * The locate entry points and the Stop locating action are wired through the
 * monitoring route's search state only: no component may invent a subject label
 * or mutate the subject registry.
 */
describe("locate entry-point labels", () => {
  const button = read("src/components/common/LocateSubjectButton.tsx");

  it("labels the shared action with the anonymous subject number", () => {
    expect(button).toContain("Locate {expectedSubjectLabel(target.subjectNumber)}");
    expect(expectedSubjectLabel(17)).toBe("S017");
  });

  it("exposes no roster identity or raw tracker id", () => {
    expect(button).not.toMatch(/studentName|nationalId|trackingId/);
  });

  it("is used by Event Details and Subject Review", () => {
    for (const path of [
      "src/components/events/EventDetailsDialog.tsx",
      "src/components/events/SubjectReviewPanel.tsx",
    ]) {
      expect(read(path)).toContain("<LocateSubjectButton");
    }
  });
});

describe("stop locating", () => {
  const monitoring = read("src/routes/_authenticated/monitoring.tsx");

  it("offers the action only while a locate target exists", () => {
    expect(monitoring).toContain("STOP LOCATING");
    expect(monitoring).toContain("{locateTarget && (");
  });

  it("clears both locate search parameters by replacing the route search", () => {
    expect(monitoring).toContain('void navigate({ to: "/monitoring", search: {}, replace: true })');
    // Clearing the search state removes the target, which disables polling.
    expect(parseLocateSearch({})).toBeNull();
    expect(parseLocateSearch({ locateSession: undefined, locateSubject: undefined })).toBeNull();
  });

  it("never touches the subject registry from the console", () => {
    expect(monitoring).not.toMatch(/session_subjects|registry\.|resolveSubject/);
  });
});
