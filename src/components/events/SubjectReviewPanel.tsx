import { useMemo, useState } from "react";
import { SeverityBadge, StatusBadge, eventTypeLabel } from "@/components/common/EventBadges";
import { Panel } from "@/components/common/Panel";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useExamSessionEvents } from "@/hooks/use-monitoring";
import { useExamSessions } from "@/hooks/use-exams";
import { useEventAttribution } from "@/hooks/use-subject-attribution";
import { displaySeverity } from "@/lib/event-presentation";
import { formatTimestamp } from "@/lib/format";
import {
  isPendingEvent,
  subjectReviewView,
  type SubjectReviewGroup,
} from "@/lib/subject-review";
import type { DetectionEvent, EventSubjectAttribution } from "@/types";

type IdentityFilter = "all" | "resolved" | "unresolved";

/** One linked event row. Opening it always reuses the shared Event details dialog. */
function EventRow({
  event,
  onOpenEvent,
}: {
  event: DetectionEvent;
  onOpenEvent: (event: DetectionEvent) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onOpenEvent(event)}
      className="flex w-full items-center gap-3 border-t border-border/40 px-3 py-1.5 text-left hover:bg-surface-2/60"
    >
      <span className="w-40 font-mono text-[11px] tabular-nums text-muted-foreground">
        {formatTimestamp(event.detectedAt)}
      </span>
      <span className="flex-1 text-[12px] text-foreground">{eventTypeLabel(event.type)}</span>
      <span className="w-32 truncate text-[11px] text-muted-foreground">{event.cameraName}</span>
      <span className="w-20 text-[11px] tabular-nums text-muted-foreground">
        {Math.round((event.triggerConfidence ?? event.confidence) * 100)}%
      </span>
      <span className="w-16 text-[10px] text-muted-foreground">
        {event.snapshotPath ? "Snapshot" : "No snapshot"}
      </span>
      <SeverityBadge severity={displaySeverity(event)} />
      <StatusBadge status={event.status} />
    </button>
  );
}

function SubjectGroupCard({
  group,
  attributionFor,
  onOpenEvent,
  onResolveIdentity,
}: {
  group: SubjectReviewGroup;
  attributionFor: (eventId: string) => readonly EventSubjectAttribution[];
  onOpenEvent: (event: DetectionEvent) => void;
  onResolveIdentity: (attribution: EventSubjectAttribution) => void;
}) {
  const [open, setOpen] = useState(false);
  // Reuses the existing identity workflow; the row is only the entry point.
  const identityTarget = useMemo(() => {
    for (const event of group.events) {
      const row = attributionFor(event.id).find(
        (item) => item.sessionSubjectId === group.sessionSubjectId,
      );
      if (row) return row;
    }
    return null;
  }, [group, attributionFor]);

  return (
    <div className="rounded-[4px] border border-border/70 bg-background/40">
      <div className="flex flex-wrap items-center gap-3 px-3 py-2">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="flex min-w-56 flex-1 items-baseline gap-2 text-left"
        >
          <span className="font-mono text-sm text-foreground">{group.subjectLabel}</span>
          {group.resolution ? (
            <span className="text-[11px] text-muted-foreground">
              {group.resolution.studentFullName} · {group.resolution.studentUniversityId}
            </span>
          ) : (
            <span className="text-[11px] text-muted-foreground">Identity unresolved</span>
          )}
        </button>
        <span className="text-[11px] text-warning">{group.pendingCount} pending review</span>
        <span className="text-[11px] text-muted-foreground">{group.totalCount} total</span>
        <span className="text-[11px] text-success">{group.confirmedCount} confirmed</span>
        <span className="text-[11px] text-muted-foreground">{group.rejectedCount} rejected</span>
        <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
          {group.latestDetectedAt ? formatTimestamp(group.latestDetectedAt) : "—"}
        </span>
        {group.eventTypes.length > 0 && (
          <span className="text-[10px] text-muted-foreground">
            {group.eventTypes.map((type) => eventTypeLabel(type as DetectionEvent["type"])).join(", ")}
          </span>
        )}
        {identityTarget && (
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-[11px]"
            onClick={() => onResolveIdentity(identityTarget)}
          >
            {group.resolution ? "Correct identity" : "Resolve identity"}
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-[11px]"
          onClick={() => setOpen((value) => !value)}
        >
          {open ? "Hide events" : "Show events"}
        </Button>
      </div>
      {open && (
        <div>
          {group.events.map((event) => (
            <EventRow key={event.id} event={event} onOpenEvent={onOpenEvent} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Subject-centric review queue for ONE exam session.
 *
 * It is a review convenience layer only: it groups event_subject links that the
 * trusted AI service already persisted. It never creates, guesses, repairs or
 * changes attribution, and unattributed exam events stay unattributed.
 */
export function SubjectReviewPanel({
  onOpenEvent,
  onResolveIdentity,
}: {
  onOpenEvent: (event: DetectionEvent) => void;
  onResolveIdentity: (attribution: EventSubjectAttribution) => void;
}) {
  const sessions = useExamSessions();
  const [sessionId, setSessionId] = useState("");
  const [pendingOnly, setPendingOnly] = useState(true);
  const [identity, setIdentity] = useState<IdentityFilter>("all");
  const events = useExamSessionEvents(sessionId);
  // ONE batched joined attribution read for the whole event list.
  const attribution = useEventAttribution(events.data);
  const [unattributedOpen, setUnattributedOpen] = useState(false);

  const attributionFor = (eventId: string) => attribution.map.get(eventId) ?? [];

  // Loading / failed attribution is NEVER classified as unattributed.
  const view = useMemo(
    () => subjectReviewView(events.data ?? [], attribution),
    [events.data, attribution],
  );
  const groups = view.kind === "ready" ? view.groups : [];
  const visibleGroups = useMemo(
    () =>
      groups.filter((group) => {
        if (pendingOnly && group.pendingCount === 0) return false;
        if (identity === "resolved" && !group.resolution) return false;
        if (identity === "unresolved" && group.resolution) return false;
        return true;
      }),
    [groups, pendingOnly, identity],
  );
  const unattributed = view.kind === "ready" ? view.unattributed : [];
  const unattributedPending = unattributed.filter(isPendingEvent).length;

  return (
    <Panel
      title="Subject review"
      subtitle="Groups anonymous subjects from already-persisted attribution. Nothing is guessed or re-attributed."
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <Select value={sessionId} onValueChange={setSessionId}>
            <SelectTrigger className="h-8 w-56 text-xs">
              <SelectValue placeholder="Select exam session" />
            </SelectTrigger>
            <SelectContent>
              {(sessions.data ?? []).map((session) => (
                <SelectItem key={session.id} value={session.id}>
                  {session.title}
                  {session.courseCode ? ` · ${session.courseCode}` : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={pendingOnly ? "pending" : "all"}
            onValueChange={(value) => setPendingOnly(value === "pending")}
          >
            <SelectTrigger className="h-8 w-32 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="pending">Pending only</SelectItem>
              <SelectItem value="all">All</SelectItem>
            </SelectContent>
          </Select>
          <Select value={identity} onValueChange={(value) => setIdentity(value as IdentityFilter)}>
            <SelectTrigger className="h-8 w-36 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Any identity</SelectItem>
              <SelectItem value="resolved">Resolved</SelectItem>
              <SelectItem value="unresolved">Unresolved</SelectItem>
            </SelectContent>
          </Select>
        </div>
      }
    >
      {sessionId === "" ? (
        <p className="py-8 text-center text-xs text-muted-foreground">
          Select an exam session to review its anonymous subjects.
        </p>
      ) : events.isPending ? (
        <p className="py-8 text-center text-xs text-muted-foreground">Loading exam events…</p>
      ) : view.kind === "loading" ? (
        <p className="py-8 text-center text-xs text-muted-foreground">
          Loading subject attribution…
        </p>
      ) : view.kind === "error" ? (
        <div className="flex flex-col items-center gap-2 py-8">
          <p className="text-center text-xs text-muted-foreground">
            Subject attribution could not be read, so no event can be classified yet.
          </p>
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-[11px]"
            onClick={() => attribution.refetch()}
          >
            Retry
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="rounded-[4px] border border-border/70 bg-background/40">
            <div className="flex flex-wrap items-center gap-3 px-3 py-2">
              <span className="flex-1 text-[12px] text-foreground">Unattributed exam events</span>
              <span className="text-[11px] text-warning">{unattributedPending} pending</span>
              <span className="text-[11px] text-muted-foreground">
                {unattributed.length} total
              </span>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-[11px]"
                onClick={() => setUnattributedOpen((value) => !value)}
              >
                {unattributedOpen ? "Hide" : "Show"}
              </Button>
            </div>
            {unattributedOpen &&
              (unattributed.length === 0 ? (
                <p className="border-t border-border/40 px-3 py-3 text-[11px] text-muted-foreground">
                  No unattributed events in this exam session.
                </p>
              ) : (
                unattributed.map((event) => (
                  <EventRow key={event.id} event={event} onOpenEvent={onOpenEvent} />
                ))
              ))}
            <p className="border-t border-border/40 px-3 py-1.5 text-[10px] text-muted-foreground">
              No subject ownership was confirmed in these detection frames, so they stay
              unattributed and are reviewed on their own.
            </p>
          </div>
          {visibleGroups.map((group) => (
            <SubjectGroupCard
              key={group.key}
              group={group}
              attributionFor={attributionFor}
              onOpenEvent={onOpenEvent}
              onResolveIdentity={onResolveIdentity}
            />
          ))}
          {visibleGroups.length === 0 && (
            <p className="py-8 text-center text-xs text-muted-foreground">
              No subjects match these filters.
            </p>
          )}
        </div>
      )}
    </Panel>
  );
}
