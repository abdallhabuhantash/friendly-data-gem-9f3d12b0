/**
 * Truthful presentation of ONE batched attribution read.
 *
 * The critical rule: an empty successful result means "no persisted attribution
 * exists" (Unattributed). A pending or failed read means "we do not currently
 * know" and must NEVER be presented as Unattributed.
 */
import type { EventSubjectAttribution } from "@/types";

export type AttributionReadState = "pending" | "error" | "ready";

export interface AttributionRead {
  state: AttributionReadState;
  map: ReadonlyMap<string, readonly EventSubjectAttribution[]>;
}

export type EventAttributionDisplay =
  /** Not an exam event: ordinary surveillance, no identity surface at all. */
  | { kind: "none" }
  /** Attribution read still in flight. */
  | { kind: "loading" }
  /** Attribution read failed; identity is unknown, not absent. */
  | { kind: "unavailable" }
  /** Read succeeded and truthfully returned zero links. */
  | { kind: "unattributed" }
  | { kind: "attributed"; rows: readonly EventSubjectAttribution[] };

export function eventAttributionDisplay(
  read: AttributionRead,
  examSessionId: string | null,
  eventId: string,
): EventAttributionDisplay {
  if (!examSessionId) return { kind: "none" };
  if (read.state === "pending") return { kind: "loading" };
  if (read.state === "error") return { kind: "unavailable" };
  const rows = read.map.get(eventId) ?? [];
  if (rows.length === 0) return { kind: "unattributed" };
  return { kind: "attributed", rows };
}
