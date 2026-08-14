/**
 * Server-only access to the local Python AI service.
 *
 * The configured endpoint is validated, the service key never leaves the server
 * and is redacted out of anything the service echoes back. If the service is not
 * configured or not reachable, the truthful failure is reported and nothing is
 * assumed to have happened.
 */

export type AiServiceOutcome = { ok: true; body: unknown } | { ok: false; message: string };

export async function aiServiceCall(
  path: string,
  method: "GET" | "POST" = "POST",
): Promise<AiServiceOutcome> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: settings } = await supabaseAdmin
    .from("system_settings")
    .select("ai_service_url")
    .maybeSingle();

  const base = (settings?.ai_service_url ?? "").trim().replace(/\/$/, "");
  if (base === "") {
    return { ok: false, message: "The AI service endpoint is not configured in Settings." };
  }
  let origin: URL;
  try {
    origin = new URL(base);
  } catch {
    return { ok: false, message: "The configured AI service endpoint is not a valid URL." };
  }
  if (origin.protocol !== "http:" && origin.protocol !== "https:") {
    return { ok: false, message: "The AI service endpoint must be an http(s) URL." };
  }

  const serviceKey = process.env["AI_SERVICE_KEY"];
  if (!serviceKey) {
    return { ok: false, message: "AI_SERVICE_KEY is not set, so the AI service stays closed." };
  }

  try {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { "X-Service-Key": serviceKey },
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
      return { ok: false, message: detail || `AI service returned ${response.status}.` };
    }
    return { ok: true, body: text === "" ? {} : (JSON.parse(text) as unknown) };
  } catch {
    return { ok: false, message: "The AI service is unreachable." };
  }
}
