import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  ATTRIBUTION_REALTIME_TABLES,
  invalidateAttribution,
} from "@/lib/attribution-realtime";

/**
 * Dedicated realtime invalidation for attribution data.
 *
 * `event_subjects` may be inserted AFTER the event row (retry path), and
 * `subject_identity_resolutions` may change in another reviewer's tab, so both
 * must invalidate the batched attribution query. No polling, no extra state.
 */
export function useRealtimeAttribution() {
  const queryClient = useQueryClient();

  useEffect(() => {
    let channel = supabase.channel("attribution-stream");
    for (const table of ATTRIBUTION_REALTIME_TABLES) {
      channel = channel.on("postgres_changes", { event: "*", schema: "public", table }, () => {
        invalidateAttribution(queryClient);
      });
    }
    channel.subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [queryClient]);
}
