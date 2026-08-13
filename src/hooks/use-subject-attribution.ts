import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { subjectAttributionService } from "@/services/subject-attribution-service";
import type { DetectionEvent, EventSubjectAttribution } from "@/types";

/**
 * Attribution for a whole list of events in ONE joined read. Events without an
 * exam session are excluded, so ordinary surveillance never queries identity.
 */
export const useEventAttribution = (events: readonly DetectionEvent[] | undefined) => {
  const eventIds = useMemo(
    () =>
      (events ?? [])
        .filter((event) => event.examSessionId !== null)
        .map((event) => event.id)
        .sort(),
    [events],
  );
  const query = useQuery({
    queryKey: ["event-subject-attribution", eventIds],
    queryFn: () => subjectAttributionService.forEvents(eventIds),
    enabled: eventIds.length > 0,
  });
  const empty = useMemo(() => new Map<string, EventSubjectAttribution[]>(), []);
  return { map: query.data ?? empty, isPending: query.isPending && eventIds.length > 0 };
};

const useInvalidateAttribution = () => {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ["event-subject-attribution"] });
  };
};

/** Explicit human resolution. Never called automatically by any effect. */
export const useResolveSubjectIdentity = () => {
  const invalidate = useInvalidateAttribution();
  return useMutation({
    mutationFn: subjectAttributionService.resolveIdentity,
    onSuccess: invalidate,
  });
};

export const useRevokeSubjectIdentity = () => {
  const invalidate = useInvalidateAttribution();
  return useMutation({
    mutationFn: ({ resolutionId, reason }: { resolutionId: string; reason: string }) =>
      subjectAttributionService.revokeIdentity(resolutionId, reason),
    onSuccess: invalidate,
  });
};
