/**
 * Server-only read of the admin-configured AI service endpoint.
 *
 * Managed Lovable Cloud injects SUPABASE_SERVICE_ROLE_KEY into the deployed
 * app, but a LOCAL checkout never has it. Touching the privileged client in
 * that case throws (and logs `Missing Supabase environment variable(s):
 * SUPABASE_SERVICE_ROLE_KEY` on every poll), which used to break monitoring
 * locally even though the Python AI service was healthy.
 *
 * So the endpoint is read from whichever source is actually available:
 *   1. the privileged client, when a service-role key exists (deployed app);
 *   2. the server-only `AI_SERVICE_URL` env var, for local development.
 * The URL is never hardcoded and no secret is ever exposed to the browser.
 */

export function hasServiceRoleKey(): boolean {
  return Boolean(process.env["SUPABASE_URL"] && process.env["SUPABASE_SERVICE_ROLE_KEY"]);
}

export async function readAiServiceUrl(): Promise<string> {
  if (hasServiceRoleKey()) {
    try {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { data } = await supabaseAdmin
        .from("system_settings")
        .select("ai_service_url")
        .maybeSingle();
      const configured = (data?.ai_service_url ?? "").trim().replace(/\/$/, "");
      if (configured !== "") return configured;
    } catch {
      /* fall through to the local env override below */
    }
  }
  return (process.env["AI_SERVICE_URL"] ?? "").trim().replace(/\/$/, "");
}
