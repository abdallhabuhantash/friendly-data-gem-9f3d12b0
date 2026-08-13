import type { EventAttributionDisplay } from "@/lib/attribution-state";

/**
 * Honest, compact rendering of an event's anonymous subject attribution.
 *
 * - No exam session: the event is ordinary surveillance, shown as "—".
 * - Attribution read still loading: "Loading subject…" — never "Unattributed".
 * - Attribution read failed: "Subject unavailable" — never "Unattributed".
 * - Successful read with zero links: "Unattributed" (truthfully no persisted
 *   subject ownership in the detection frame), never a guessed subject.
 * - Attributed but unresolved: only the anonymous label is shown.
 * - Resolved: the human-decided student is shown BESIDE the anonymous label,
 *   never replacing it.
 */
export function SubjectAttributionSummary({
  display,
  compact = false,
}: {
  display: EventAttributionDisplay;
  compact?: boolean;
}) {
  if (display.kind === "none") return <span className="text-muted-foreground">—</span>;
  if (display.kind === "loading") {
    return (
      <span
        className="text-[11px] text-muted-foreground"
        title="Reading persisted subject attribution."
      >
        Loading subject…
      </span>
    );
  }
  if (display.kind === "unavailable") {
    return (
      <span
        className="text-[11px] text-muted-foreground"
        title="The subject attribution could not be read, so it is unknown — not absent."
      >
        Subject unavailable
      </span>
    );
  }
  if (display.kind === "unattributed") {
    return (
      <span
        className="text-[11px] text-muted-foreground"
        title="No subject ownership was confirmed in the detection frame."
      >
        Unattributed
      </span>
    );
  }
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {display.rows.map((item) => (
        <span
          key={item.eventSubjectId || `${item.eventId}-${item.participantIndex}`}
          className="inline-flex items-center gap-1 rounded-[3px] border border-border/70 bg-background/50 px-1.5 py-0.5"
        >
          <span className="font-mono text-[11px] text-foreground">{item.subjectLabel}</span>
          {item.resolution ? (
            <span className="text-[10px] text-muted-foreground">
              {compact
                ? item.resolution.studentUniversityId
                : `${item.resolution.studentFullName} · ${item.resolution.studentUniversityId}`}
            </span>
          ) : (
            <span className="text-[10px] text-muted-foreground">anonymous</span>
          )}
        </span>
      ))}
    </span>
  );
}
