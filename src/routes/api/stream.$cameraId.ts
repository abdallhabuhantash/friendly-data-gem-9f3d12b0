import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/stream/$cameraId")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const { verifyStreamTicket } = await import("@/lib/stream-ticket.server");
        const ticket = new URL(request.url).searchParams.get("t");
        if (!verifyStreamTicket(params.cameraId, ticket)) {
          return new Response("Unauthorized", { status: 401 });
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { data: settings } = await supabaseAdmin
          .from("system_settings")
          .select("ai_service_url")
          .maybeSingle();

        const base = (settings?.ai_service_url ?? "").trim().replace(/\/$/, "");
        // The Python AI service is optional (not running in preview/demo).
        // Return 4xx instead of 5xx so it is treated as "no stream yet",
        // not as an application error.
        if (!base) return new Response("AI service is not configured", { status: 404 });

        // Defence in depth: the endpoint is admin-configured, but the proxy
        // still only ever forwards to an http(s) origin — never file:, data:
        // or any other scheme. The destination is never client-controlled.
        let origin: URL;
        try {
          origin = new URL(base);
        } catch {
          return new Response("AI service endpoint is invalid", { status: 404 });
        }
        if (origin.protocol !== "http:" && origin.protocol !== "https:") {
          return new Response("AI service endpoint is invalid", { status: 404 });
        }

        // The AI service always requires the shared key, so a missing key is a
        // configuration fault — reported as such instead of a blind 401 upstream.
        const serviceKey = process.env["AI_SERVICE_KEY"];
        if (!serviceKey) {
          return new Response("AI_SERVICE_KEY is not configured for this app", { status: 404 });
        }
        const headers: Record<string, string> = { "X-Service-Key": serviceKey };

        try {
          const { bindUpstreamToDownstream } = await import("@/lib/stream-proxy");
          // The downstream (browser) request signal is tied to the upstream
          // fetch AND to the response body: when the operator switches camera,
          // leaves Live Monitoring or the connection closes, the upstream Python
          // MJPEG request is aborted instead of being left orphaned.
          const upstream = await fetch(`${base}/stream/${params.cameraId}`, {
            headers,
            signal: request.signal,
          });
          const decision = bindUpstreamToDownstream(
            {
              ok: upstream.ok,
              body: upstream.body,
              contentType: upstream.headers.get("content-type"),
            },
            request.signal,
          );
          if (decision.kind === "unavailable") {
            return new Response("Stream unavailable", { status: 404 });
          }
          if (decision.kind === "cancelled") {
            return new Response("Stream cancelled", { status: 499 });
          }
          // Progressive streaming only: the MJPEG body is never buffered.
          // `x-accel-buffering: no` stops intermediate proxies (and the tunnel)
          // from accumulating a multi-second backlog of annotated frames.
          return new Response(upstream.body, {
            status: 200,
            headers: {
              "content-type": decision.contentType,
              "cache-control": "no-store",
              "x-accel-buffering": "no",
              "content-encoding": "identity",
            },
          });

        } catch {
          return new Response("Stream unreachable", { status: 404 });
        }


      },
    },
  },
});
