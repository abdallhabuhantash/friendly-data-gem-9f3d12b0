/**
 * Prompt 10 — operator-facing raw tracker ID cleanup.
 *
 * These are deterministic source-contract tests: they assert that the
 * operator-facing Events / evidence-review components never render raw AI
 * tracker identifiers, while internal identifiers stay available for
 * association geometry, React keys and event persistence.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

const eventDetails = read("src/components/events/EventDetailsDialog.tsx");
const overlay = read("src/components/monitoring/DetectionOverlayLayer.tsx");
const eventsRoute = read("src/routes/_authenticated/events.tsx");
const presentation = read("src/lib/event-presentation.ts");
const types = read("src/types/index.ts");

describe("EventDetailsDialog raw-ID removal", () => {
  it("A. no longer contains a 'Person track' row", () => {
    expect(eventDetails).not.toContain("Person track");
    expect(eventDetails).not.toMatch(/label="Person/);
  });

  it("B. does not render displayPersonId or raw tracking fields", () => {
    expect(eventDetails).not.toContain("displayPersonId");
    expect(eventDetails).not.toContain("personTrackingId");
  });

  it("keeps the association / duration / review metadata rows", () => {
    for (const label of [
      'label="Association"',
      'label="Association conf."',
      'label="Trigger object"',
      'label="Duration"',
      'label="Frames"',
      'label="Reviewed by"',
    ]) {
      expect(eventDetails).toContain(label);
    }
  });

  it("F. uses SubjectAttributionSummary for exam identity", () => {
    expect(eventDetails).toContain("SubjectAttributionSummary");
    expect(eventsRoute).toContain("SubjectAttributionSummary");
  });
});

describe("DetectionOverlayLayer caption", () => {
  it("C. does not render a tracking ID in the visible caption", () => {
    expect(overlay).not.toMatch(/ID \$\{/);
    expect(overlay).not.toContain("detection.trackingId");
  });

  it("D. still uses internal identifiers for keys and connector geometry", () => {
    expect(overlay).toContain("key={detection.objectId}");
    expect(overlay).toContain("detection.associatedPersonId");
    expect(overlay).toContain("item.objectId === detection.associatedPersonId");
  });

  it("E. still displays class / association wording and confidence", () => {
    expect(overlay).toContain("Uncertain association");
    expect(overlay).toContain('detection.className.replace("_", " ")');
    expect(overlay).toContain("Math.round(detection.confidence * 100)");
  });
});

describe("no operator-facing Sxxx derivation from tracker IDs", () => {
  it("G. events surfaces never derive subject labels from personTrackingId", () => {
    for (const source of [eventDetails, eventsRoute, overlay]) {
      expect(source).not.toContain("personTrackingId");
      expect(source).not.toMatch(/S\$\{/);
    }
  });

  it("the presentation helper no longer exposes a raw person-ID formatter", () => {
    expect(presentation).not.toContain("displayPersonId");
  });
});

describe("internal contracts untouched", () => {
  it("H. DetectionEvent / DetectionEvidence keep their tracking fields", () => {
    expect(types).toContain("personTrackingId: string | null;");
    expect(types).toContain("trackingId: string | null;");
  });

  it("evidence-to-overlay mapping still carries internal identifiers", () => {
    const overlays = read("src/services/detection-overlays.ts");
    expect(overlays).toContain("trackingId: item.trackingId");
    expect(overlays).toContain("associatedPersonTrackingId");
  });
});
