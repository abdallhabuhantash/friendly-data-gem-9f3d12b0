import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { getStreamHealth } from "@/lib/stream-health.functions";
import type { StreamHealthReply } from "@/lib/stream-health";

/** Cadence of the single page-level live-stream health poll. */
export const STREAM_HEALTH_POLL_MS = 2_000;

/**
 * One shared measured stream-health poll for the whole Live Monitoring page.
 * Never one poll per camera: every tile reads this same result.
 */
export function useStreamHealth(enabled: boolean) {
  const read = useServerFn(getStreamHealth);
  return useQuery<StreamHealthReply>({
    queryKey: ["stream-health"],
    queryFn: () => read(),
    enabled,
    refetchInterval: STREAM_HEALTH_POLL_MS,
    // Health must be current: a failed read is a failure, not a reason to keep
    // showing the previous answer as if it were still true.
    retry: false,
    gcTime: 0,
  });
}

export type StreamHealthQuery = ReturnType<typeof useStreamHealth>;
