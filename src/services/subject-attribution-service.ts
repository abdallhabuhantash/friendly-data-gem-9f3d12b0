/**
 * Event -> anonymous subject attribution reads, and the human-only
 * subject -> roster identity resolution.
 *
 * Truthfulness rules enforced here:
 * - Attribution facts are read-only. The console never creates or edits a link;
 *   only the trusted AI service writes them.
 * - Identity resolution is never automatic and never inferred. It is always an
 *   explicit human decision, recorded through a controlled backend operation
 *   that stamps the signed-in user as the resolver.
 * - Attribution for a whole page of events is fetched in ONE joined read, so no
 *   event row triggers its own identity query.
 */
import { supabase } from "@/integrations/supabase/client";
import type { EventSubjectAttribution } from "@/types";

const fail = (error: { message: string } | null): void => {
  if (error) throw new Error(error.message);
};

export const subjectAttributionService = {
  /** All attribution facts for the given events, keyed by event id. */
  async forEvents(eventIds: readonly string[]): Promise<Map<string, EventSubjectAttribution[]>> {
    const grouped = new Map<string, EventSubjectAttribution[]>();
    if (eventIds.length === 0) return grouped;
    const response = await supabase
      .from("event_subject_identity_view")
      .select("*")
      .in("event_id", [...eventIds])
      .order("participant_index", { ascending: true });
    fail(response.error);

    for (const row of response.data ?? []) {
      if (!row.event_id || !row.session_subject_id || !row.exam_session_id) continue;
      const attribution: EventSubjectAttribution = {
        eventSubjectId: row.event_subject_id ?? "",
        eventId: row.event_id,
        examSessionId: row.exam_session_id,
        sessionSubjectId: row.session_subject_id,
        subjectNumber: Number(row.subject_number ?? 0),
        subjectLabel: row.subject_label ?? "",
        participantIndex: Number(row.participant_index ?? 1),
        participantRole: row.participant_role ?? "subject",
        linkMethod: row.link_method ?? "frame_subject_ownership",
        linkConfidence: row.link_confidence === null ? null : Number(row.link_confidence),
        linkedAt: row.linked_at ?? "",
        resolution:
          row.resolution_id && row.exam_roster_student_id
            ? {
                id: row.resolution_id,
                rosterStudentId: row.exam_roster_student_id,
                studentFullName: row.student_full_name ?? "",
                studentUniversityId: row.student_university_id ?? "",
                resolvedAt: row.resolved_at ?? "",
                resolvedByName: row.resolved_by_name ?? null,
              }
            : null,
      };
      const bucket = grouped.get(attribution.eventId);
      if (bucket) bucket.push(attribution);
      else grouped.set(attribution.eventId, [attribution]);
    }
    return grouped;
  },

  /**
   * Records the human decision that one anonymous subject represents one roster
   * student. A correction of an existing identity requires an explicit reason;
   * the previous decision is superseded in the audit history, never deleted.
   */
  async resolveIdentity(input: {
    sessionSubjectId: string;
    rosterStudentId: string;
    correctionReason?: string | undefined;
  }): Promise<void> {
    const { error } = await supabase.rpc("resolve_subject_identity", {
      _session_subject_id: input.sessionSubjectId,
      _exam_roster_student_id: input.rosterStudentId,
      _correction_reason: input.correctionReason ?? null,
    });
    fail(error);
  },

  /** Withdraws an identity decision, keeping the full audit history. */
  async revokeIdentity(resolutionId: string, correctionReason: string): Promise<void> {
    const { error } = await supabase.rpc("revoke_subject_identity", {
      _resolution_id: resolutionId,
      _correction_reason: correctionReason,
    });
    fail(error);
  },
};
