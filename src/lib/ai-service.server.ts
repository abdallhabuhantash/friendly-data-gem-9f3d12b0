/**
 * Server-only access to the local Python AI service.
 *
 * The configured endpoint is validated, the service key never leaves the server
 * and is redacted out of anything the service echoes back. If the service is not
 * configured or not reachable, the truthful failure is reported and nothing is
 * assumed to have happened.
 *
 * Reachability is reported alongside the failure: the published cloud app cannot
 * reach a loopback/LAN endpoint, and the console must say that plainly instead
 * of implying the service is merely starting up.
 */

import { AI_ENDPOINT_GUIDANCE, AI_ENDPOINT_UNREACHABLE_MESSAGE, classifyAiEndpoint } from "./ai-endpoint";
import type { AiEndpointReach } from "./ai-endpoint";

export type AiServiceOutcome =
  | { ok: true; body: unknown }
  | { ok: false; message: string; reach: AiEndpointReach };

export async function aiServiceCall(
  path: string,
  method: "GET" | "POST" = "POST",
  /**
   * Optional bounded deadline in milliseconds. Used ONLY by the fast local
   * `/status` health poll: a hung status request must resolve as "health
   * unavailable" instead of hanging forever. Exam arm/end/locate calls keep
   * their unbounded behaviour.
   */
  timeoutMs?: number,
): Promise<AiServiceOutcome> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: settings } = await supabaseAdmin
    .from("system_settings")
    .select("ai_service_url")
    .maybeSingle();

  const base = (settings?.ai_service_url ?? "").trim().replace(/\/$/, "");
  const reach = classifyAiEndpoint(base);
  if (reach === "unset") {
    return {
      ok: false,
      reach,
      message: `The AI service endpoint is not configured in Settings. ${AI_ENDPOINT_GUIDANCE.unset}`,
    };
  }
  if (reach === "invalid") {
    return {
      ok: false,
      reach,
      message: "The configured AI service endpoint is not a valid http(s) URL.",
    };
  }

  const serviceKey = process.env["AI_SERVICE_KEY"];
  if (!serviceKey) {
    return {
      ok: false,
      reach,
      message: "AI_SERVICE_KEY is not set, so the AI service stays closed.",
    };
  }

  try {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { "X-Service-Key": serviceKey },
      ...(timeoutMs !== undefined ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
    });
    const text = await response.text();
    if (!response.ok) {
      let detail = text;
      try {
        detail = String((JSON.parse(text) as { detail?: string }).detail ?? text);
      } catch {
        /* plain-text error body */
      }
      // The service key never travels back to the browser, whatever is echoed.
      detail = detail.split(serviceKey).join("[redacted]").slice(0, 400);
      return { ok: false, reach, message: detail || `AI service returned ${response.status}.` };
    }
    return { ok: true, body: text === "" ? {} : (JSON.parse(text) as unknown) };
  } catch {
    return {
      ok: false,
      reach,
      message:
        reach === "local_only"
          ? AI_ENDPOINT_UNREACHABLE_MESSAGE
          : "The AI service is unreachable.",
    };
  }
}
