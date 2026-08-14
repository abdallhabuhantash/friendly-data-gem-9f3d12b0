/**
 * Pure "locate this anonymous subject" contract for the web console.
 *
 * The console never decides where a subject is. It asks the AI service, and it
 * only draws a highlight when the service proved a real, current observation of
 * exactly the subject that was asked for. Every other answer is shown as an
 * honest textual status with no box on screen: an operator must never be pointed
 * at the wrong person.
 */

export const LOCATE_STATES = [
  "located",
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
] as const;

export type LocateState = (typeof LOCATE_STATES)[number];

/** Normalized (0..1) box in the analysed frame's coordinate space. */
export interface NormalizedBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SubjectLocateResult {
  examSessionId: string;
  subjectNumber: number;
  subjectLabel: string;
  locateState: LocateState;
  cameraId: string | null;
  lastSeenAt: string | null;
  bbox: NormalizedBox | null;
}

export interface LocateTarget {
  examSessionId: string;
  subjectNumber: number;
}

type Parsed = { ok: true; value: SubjectLocateResult } | { ok: false; message: string };

const MALFORMED = "The AI service returned an unexpected locate reply, so nothing is shown.";

const isState = (value: unknown): value is LocateState =>
  typeof value === "string" && (LOCATE_STATES as readonly string[]).includes(value);

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** A box is only usable when it is fully normalized and has real area. */
export function normalizedBox(raw: unknown): NormalizedBox | null {
  if (typeof raw !== "object" || raw === null) return null;
  const body = raw as Record<string, unknown>;
  const { x, y, width, height } = body;
  if (!finite(x) || !finite(y) || !finite(width) || !finite(height)) return null;
  if (width <= 0 || height <= 0) return null;
  if (x < 0 || y < 0 || x + width > 1.0000001 || y + height > 1.0000001) return null;
  return { x, y, width, height };
}

/**
 * Strict reply validation. The result must be about the requested session and
 * subject number, and a `located` answer must carry a camera and a valid box —
 * otherwise it is rejected rather than displayed optimistically.
 */
export function parseLocateReply(raw: unknown, target: LocateTarget): Parsed {
  if (typeof raw !== "object" || raw === null) return { ok: false, message: MALFORMED };
  const body = raw as Record<string, unknown>;
  const state = body["locate_state"];
  if (!isState(state)) return { ok: false, message: MALFORMED };
  if (body["exam_session_id"] !== target.examSessionId) return { ok: false, message: MALFORMED };
  if (body["subject_number"] !== target.subjectNumber) return { ok: false, message: MALFORMED };
  const label =
    typeof body["subject_label"] === "string" && body["subject_label"].trim() !== ""
      ? body["subject_label"]
      : `S${String(target.subjectNumber).padStart(3, "0")}`;
  const camera = typeof body["camera_id"] === "string" ? body["camera_id"] : null;
  const lastSeenAt =
    typeof body["last_seen_at"] === "string" && !Number.isNaN(Date.parse(body["last_seen_at"]))
      ? body["last_seen_at"]
      : null;
  const bbox = normalizedBox(body["bbox"]);
  if (state === "located" && (bbox === null || camera === null)) {
    return { ok: false, message: MALFORMED };
  }
  return {
    ok: true,
    value: {
      examSessionId: target.examSessionId,
      subjectNumber: target.subjectNumber,
      subjectLabel: label,
      locateState: state,
      cameraId: camera,
      lastSeenAt,
      // A non-located answer never carries a highlight, whatever was sent.
      bbox: state === "located" ? bbox : null,
    },
  };
}

/** Truthful operator wording for every possible locate answer. */
export function locateStatusMessage(state: LocateState, label: string): string {
  switch (state) {
    case "located":
      return `${label} is currently observed.`;
    case "temporarily_lost":
      return `${label} is temporarily out of view, so no position is shown.`;
    case "lost":
      return `${label} is no longer being observed, so no position is shown.`;
    case "unresolved":
      return `${label} is not currently matched to an observed person, so no position is shown.`;
    case "provisional":
      return `${label} is only provisionally matched, so no position is shown.`;
    case "conflict":
      return `${label} has a conflicting match, so no position is shown.`;
    case "ended":
      return `${label} was closed when the exam session ended, so no live position exists.`;
    case "not_armed":
      return "This exam session is not being monitored right now, so no live position exists.";
    case "not_found":
      return `${label} does not exist in this exam session's monitoring.`;
    case "ambiguous":
      return `${label} could not be located unambiguously, so no position is shown.`;
    case "unavailable":
      return `${label} has no confirmed position available yet.`;
  }
}

/** Only a verified, matching, located result may draw a highlight. */
export function locateHighlight(
  result: SubjectLocateResult | null | undefined,
  target: LocateTarget | null,
  cameraId: string | null | undefined,
): { box: NormalizedBox; label: string } | null {
  if (!result || !target) return null;
  if (result.locateState !== "located" || result.bbox === null) return null;
  if (result.examSessionId !== target.examSessionId) return null;
  if (result.subjectNumber !== target.subjectNumber) return null;
  // The highlight belongs to one camera only; it is never re-used elsewhere.
  if (!cameraId || result.cameraId !== cameraId) return null;
  return { box: result.bbox, label: result.subjectLabel };
}

/**
 * Which camera the viewport should switch to, if any. Switching only happens
 * for a proven observation on a camera that actually exists in this console.
 */
export function locateCameraSelection(
  result: SubjectLocateResult | null | undefined,
  availableCameraIds: readonly string[],
): string | null {
  if (!result || result.locateState !== "located" || !result.cameraId) return null;
  return availableCameraIds.includes(result.cameraId) ? result.cameraId : null;
}

/** Search parameters used to hand a locate request to the monitoring console. */
export function locateSearch(target: LocateTarget): {
  locateSession: string;
  locateSubject: number;
} {
  return { locateSession: target.examSessionId, locateSubject: target.subjectNumber };
}

/** Parses (and rejects) the monitoring route's locate search parameters. */
export function parseLocateSearch(raw: unknown): LocateTarget | null {
  if (typeof raw !== "object" || raw === null) return null;
  const body = raw as Record<string, unknown>;
  const session = body["locateSession"];
  const subject = Number(body["locateSubject"]);
  if (typeof session !== "string" || session.trim() === "") return null;
  if (!Number.isInteger(subject) || subject < 1) return null;
  return { examSessionId: session, subjectNumber: subject };
}

/**
 * A locate entry point is only offered for an attribution that already links a
 * persisted anonymous subject of one exam session. Locate never guesses which
 * subject an unattributed event belongs to.
 */
export function locateTargetFor(attribution: {
  examSessionId?: string | null;
  subjectNumber?: number | null;
}): LocateTarget | null {
  const session = attribution.examSessionId;
  const subject = attribution.subjectNumber;
  if (typeof session !== "string" || session.trim() === "") return null;
  if (typeof subject !== "number" || !Number.isInteger(subject) || subject < 1) return null;
  return { examSessionId: session, subjectNumber: subject };
}
