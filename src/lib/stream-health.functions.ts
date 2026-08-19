import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * ONE authenticated page-level read of measured live-stream health.
 *
 * The Python `/status` document is fetched server-side (the service key never
 * reaches the browser) and reduced to the minimum safe per-camera facts:
 * `id`, `connected`, `streaming`. There is deliberately no per-camera endpoint:
 * the whole monitoring page — viewport and camera wall — shares this one result.
 */
/** Operational deadline for the fast local /status health poll (~2s cadence). */
export const STATUS_TIMEOUT_MS = 1_500;

export const getStreamHealth = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const { aiServiceCall } = await import("./ai-service.server");
    const { minimalCameraStreamHealth } = await import("./stream-health");
    // Bounded: the local /status endpoint is fast, and a hung request must
    // surface as "health unavailable" rather than keeping the previous answer.
    const outcome = await aiServiceCall("/status", "GET", STATUS_TIMEOUT_MS);
    if (!outcome.ok) {
      // The reachability class (never the URL itself) travels to the console so
      // the operator is told to fix Settings instead of waiting forever.
      return { ok: false as const, message: outcome.message, reach: outcome.reach };
    }
    return { ok: true as const, cameras: minimalCameraStreamHealth(outcome.body) };
  });
