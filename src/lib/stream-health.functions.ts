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
export const getStreamHealth = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const { aiServiceCall } = await import("./ai-service.server");
    const { minimalCameraStreamHealth } = await import("./stream-health");
    const outcome = await aiServiceCall("/status", "GET");
    if (!outcome.ok) return { ok: false as const, message: outcome.message };
    return { ok: true as const, cameras: minimalCameraStreamHealth(outcome.body) };
  });
