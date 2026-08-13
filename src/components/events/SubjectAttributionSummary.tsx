import type { EventSubjectAttribution } from "@/types";

/**
 * Honest, compact rendering of an event's anonymous subject attribution.
 *
 * - No exam session: the event is ordinary surveillance, shown as "—".
 * - Exam session but no confirmed subject ownership in the detection frame:
 *   shown as "Unattributed", never as a guessed subject.
 * - Attributed but unresolved: only the anonymous label is shown.
 * - Resolved: the human-decided student is shown BESIDE the anonymous label,
 *   never replacing it.
 */
export function SubjectAttributionSummary({
  attributions,
  examSessionId,
  compact = false,
}: {
  attributions: readonly EventSubjectAttribution[];
  examSessionId: string | null;
  compact?: boolean;
}) {
  if (!examSessionId) return <span className="text-muted-foreground">—</span>;
  if (attributions.length === 0) {
    return (
      <span className="text-[11px] text-muted-foreground" title="No subject ownership was confirmed in the detection frame.">
        Unattributed
      </span>
    );
  }
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {attributions.map((item) => (
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
