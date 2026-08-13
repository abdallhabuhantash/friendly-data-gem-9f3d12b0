import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { ATTRIBUTION_QUERY_KEY, invalidateAttribution } from "@/lib/attribution-realtime";
import type { AttributionRead, AttributionReadState } from "@/lib/attribution-state";
import { subjectAttributionService } from "@/services/subject-attribution-service";
import type { DetectionEvent, EventSubjectAttribution } from "@/types";

export interface EventAttributionResult extends AttributionRead {
  /** Read still in flight: identity is unknown, NOT absent. */
  isPending: boolean;
  /** Read failed: identity is unknown, NOT absent. */
  isError: boolean;
  error: unknown;
  refetch: () => void;
}

/**
 * Attribution for a whole list of events in ONE joined read. Events without an
 * exam session are excluded, so ordinary surveillance never queries identity.
 *
 * The query state is exposed truthfully: callers must not render a pending or
 * failed read as "Unattributed".
 */
export const useEventAttribution = (
  events: readonly DetectionEvent[] | undefined,
): EventAttributionResult => {
  const eventIds = useMemo(
    () =>
      (events ?? [])
        .filter((event) => event.examSessionId !== null)
        .map((event) => event.id)
        .sort(),
    [events],
  );
  const query = useQuery({
    queryKey: [...ATTRIBUTION_QUERY_KEY, eventIds],
    queryFn: () => subjectAttributionService.forEvents(eventIds),
    enabled: eventIds.length > 0,
  });
  const empty = useMemo(() => new Map<string, EventSubjectAttribution[]>(), []);
  const isPending = query.isPending && eventIds.length > 0;
  const isError = query.isError;
  const state: AttributionReadState = isError ? "error" : isPending ? "pending" : "ready";
  return {
    state,
    map: query.data ?? empty,
    isPending,
    isError,
    error: query.error,
    refetch: () => void query.refetch(),
  };
};

const useInvalidateAttribution = () => {
  const queryClient = useQueryClient();
  return () => invalidateAttribution(queryClient);
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
