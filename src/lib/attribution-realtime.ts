/**
 * The single attribution-freshness contract shared by the realtime hook and its
 * regression tests.
 *
 * The backend persists the Event row first and the event_subject link second
 * (with retries), so attribution can arrive later than the event itself. These
 * are the only tables whose changes must invalidate the batched attribution
 * read; no polling is used.
 */
export const ATTRIBUTION_QUERY_KEY = ["event-subject-attribution"] as const;

/** Realtime tables that make attribution/identity reads stale. */
export const ATTRIBUTION_REALTIME_TABLES = [
  "event_subjects",
  "subject_identity_resolutions",
] as const;

export type AttributionRealtimeTable = (typeof ATTRIBUTION_REALTIME_TABLES)[number];

interface InvalidatorClient {
  invalidateQueries: (filters: { queryKey: readonly unknown[] }) => unknown;
}

/** Smallest invalidation path: refetch the batched attribution read only. */
export function invalidateAttribution(queryClient: InvalidatorClient): void {
  void queryClient.invalidateQueries({ queryKey: ATTRIBUTION_QUERY_KEY });
}
