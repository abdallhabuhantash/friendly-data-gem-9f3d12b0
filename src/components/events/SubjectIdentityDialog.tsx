import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useRoster } from "@/hooks/use-exams";
import { useResolveSubjectIdentity, useRevokeSubjectIdentity } from "@/hooks/use-subject-attribution";
import { formatTimestamp } from "@/lib/format";
import type { EventSubjectAttribution } from "@/types";

/**
 * On-demand identity resolution for ONE anonymous subject.
 *
 * The subject stays anonymous unless a human explicitly picks a roster student
 * here and confirms. Nothing on this screen guesses, ranks or pre-selects a
 * student, and the AI never opens this dialog.
 */
export function SubjectIdentityDialog({
  attribution,
  onOpenChange,
}: {
  attribution: EventSubjectAttribution | null;
  onOpenChange: (open: boolean) => void;
}) {
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const roster = useRoster(attribution?.examSessionId ?? "");
  const resolve = useResolveSubjectIdentity();
  const revoke = useRevokeSubjectIdentity();

  const students = useMemo(() => {
    const term = search.trim().toLowerCase();
    const rows = roster.data ?? [];
    if (term === "") return rows;
    return rows.filter((student) =>
      `${student.universityId} ${student.fullName}`.toLowerCase().includes(term),
    );
  }, [roster.data, search]);

  if (!attribution) return null;
  const existing = attribution.resolution;
  const close = () => {
    setSearch("");
    setSelectedId(null);
    setReason("");
    setError(null);
    onOpenChange(false);
  };

  const submit = async () => {
    if (!selectedId) return;
    setError(null);
    // A correction of an existing identity always requires a written reason.
    if (existing && reason.trim() === "") {
      setError("Replacing an existing identity requires a correction reason.");
      return;
    }
    try {
      await resolve.mutateAsync({
        sessionSubjectId: attribution.sessionSubjectId,
        rosterStudentId: selectedId,
        correctionReason: reason.trim() === "" ? undefined : reason.trim(),
      });
      close();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The identity could not be recorded.");
    }
  };

  const withdraw = async () => {
    if (!existing) return;
    setError(null);
    if (reason.trim() === "") {
      setError("Withdrawing an identity requires a reason.");
      return;
    }
    try {
      await revoke.mutateAsync({ resolutionId: existing.id, reason: reason.trim() });
      close();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The identity could not be withdrawn.");
    }
  };

  const pending = resolve.isPending || revoke.isPending;
  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent className="max-w-xl border-border bg-surface">
        <DialogHeader>
          <DialogTitle className="font-mono text-sm uppercase tracking-[0.1em]">
            Resolve identity — {attribution.subjectLabel}
          </DialogTitle>
          <DialogDescription className="text-[11px]">
            {attribution.subjectLabel} is an anonymous monitoring label, not an identity. Selecting a
            student below records YOUR decision, attributed to you, and can be corrected later.
          </DialogDescription>
        </DialogHeader>

        {existing && (
          <div className="rounded-[4px] border border-border/70 bg-background/50 p-2 text-[11px] text-muted-foreground">
            Currently identified as{" "}
            <span className="text-foreground">
              {existing.studentFullName} ({existing.studentUniversityId})
            </span>{" "}
            by {existing.resolvedByName ?? "a reviewer"} on {formatTimestamp(existing.resolvedAt)}.
          </div>
        )}

        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search roster by university ID or name…"
          className="h-8 text-xs"
        />
        <div className="max-h-56 overflow-y-auto rounded-[4px] border border-border/70">
          {roster.isPending && (
            <p className="p-3 text-[11px] text-muted-foreground">Loading roster…</p>
          )}
          {!roster.isPending && students.length === 0 && (
            <p className="p-3 text-[11px] text-muted-foreground">
              No roster student matches. Import the roster for this exam session first.
            </p>
          )}
          {students.map((student) => (
            <button
              key={student.id}
              type="button"
              onClick={() => setSelectedId(student.id)}
              className={`flex w-full items-center justify-between gap-3 border-b border-border/40 px-3 py-2 text-left text-[12px] last:border-0 hover:bg-surface-2/60 ${
                selectedId === student.id ? "bg-surface-2" : ""
              }`}
            >
              <span className="text-foreground">{student.fullName}</span>
              <span className="font-mono text-[11px] text-muted-foreground">
                {student.universityId}
              </span>
            </button>
          ))}
        </div>

        <div className="space-y-1.5">
          <span className="label-tech text-muted-foreground">
            {existing ? "Correction reason (required)" : "Reason / context (optional)"}
          </span>
          <Textarea
            value={reason}
            maxLength={1000}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Why this student, and how it was verified…"
            className="min-h-16 text-xs"
          />
        </div>
        {error && <p className="text-[11px] text-destructive">{error}</p>}

        <div className="flex justify-between gap-2">
          {existing ? (
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2 text-[11px] text-destructive"
              disabled={pending}
              onClick={() => void withdraw()}
            >
              Withdraw identity
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-[11px]"
              disabled={pending}
              onClick={close}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2 text-[11px] text-success"
              disabled={pending || !selectedId}
              onClick={() => void submit()}
            >
              {existing ? "Replace identity" : "Confirm identity"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
