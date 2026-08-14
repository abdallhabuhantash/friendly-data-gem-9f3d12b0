/**
 * Pure Start / End response contract for the exam-session lifecycle.
 *
 * The web app never decides that monitoring is armed: the local AI service
 * does, and it writes the lifecycle state itself. A malformed HTTP 200 is
 * therefore treated as a failure — reporting success from a reply we cannot
 * verify would be exactly the kind of untruthful state this project forbids.
 */

export type ExamRuntimeReply = {
  armed: boolean;
  examSessionId: string;
  cameras: string[];
  startedAt: string | null;
  endedAt: string | null;
};

type Parsed = { ok: true; value: ExamRuntimeReply } | { ok: false; message: string };

const isTimestamp = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "" && !Number.isNaN(Date.parse(value));

function shape(raw: unknown): ExamRuntimeReply {
  const body = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    armed: body["armed"] === true,
    examSessionId: typeof body["exam_session_id"] === "string" ? body["exam_session_id"] : "",
    cameras: Array.isArray(body["cameras"])
      ? body["cameras"].filter((item): item is string => typeof item === "string")
      : [],
    startedAt: isTimestamp(body["started_at"]) ? body["started_at"] : null,
    endedAt: isTimestamp(body["ended_at"]) ? body["ended_at"] : null,
  };
}

const MALFORMED = "The AI service returned an unexpected reply, so nothing is reported as done.";

/** A Start only succeeded when the service confirms this session is armed. */
export function parseStartReply(raw: unknown, examSessionId: string): Parsed {
  const value = shape(raw);
  if (value.examSessionId !== examSessionId) return { ok: false, message: MALFORMED };
  if (value.armed !== true) return { ok: false, message: MALFORMED };
  if (value.startedAt === null) return { ok: false, message: MALFORMED };
  if (value.cameras.length === 0) return { ok: false, message: MALFORMED };
  return { ok: true, value };
}

/** An End only succeeded when the service confirms this session is disarmed. */
export function parseEndReply(raw: unknown, examSessionId: string): Parsed {
  const value = shape(raw);
  if (value.examSessionId !== examSessionId) return { ok: false, message: MALFORMED };
  if (value.armed !== false) return { ok: false, message: MALFORMED };
  if (value.endedAt === null) return { ok: false, message: MALFORMED };
  return { ok: true, value };
}

/** Truthful lifecycle wording: an ended session is never "not started". */
export function examLifecycleDescription(status: string): string {
  switch (status) {
    case "draft":
      return "Draft. Configuration is incomplete and monitoring has not started.";
    case "ready":
      return "Configured. Monitoring has not started.";
    case "active":
      return "Monitoring is armed. Anonymous subjects are being tracked.";
    case "ended":
      return "Monitoring has ended. Subject/event history is preserved.";
    default:
      return "Configured information only.";
  }
}

/** Configuration editing is not an ordinary action once a session ran. */
export const canEditExamConfiguration = (status: string): boolean =>
  status === "draft" || status === "ready";
