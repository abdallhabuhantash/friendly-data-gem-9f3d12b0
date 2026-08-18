/**
 * Privileged relay for the local Python AI service.
 *
 * Managed Lovable Cloud never exposes a service-role key to an external
 * machine, so the AI service asks the web app to perform its privileged
 * (Group B) database work. Every request must carry the shared AI_SERVICE_KEY
 * in `X-Service-Key`; unauthenticated requests are rejected before any data is
 * touched. Uniqueness conflicts are reported as HTTP 409 so the caller can map
 * them to its DuplicateEventError semantics.
 */

import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

const uuid = z.string().uuid();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function isConflict(error: { code?: string | null; message?: string | null } | null): boolean {
  if (!error) return false;
  return error.code === "23505" || (error.message ?? "").includes("duplicate key");
}

export const Route = createFileRoute("/api/public/ai/$operation")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        // 1. Shared-secret authentication, before anything else.
        const expected = process.env["AI_SERVICE_KEY"];
        if (!expected) return new Response("Relay is not configured", { status: 503 });
        const provided = request.headers.get("x-service-key");
        if (!provided || provided !== expected) {
          return new Response("Unauthorized", { status: 401 });
        }

        let payload: Record<string, unknown>;
        try {
          payload = (await request.json()) as Record<string, unknown>;
        } catch {
          return new Response("Invalid JSON body", { status: 400 });
        }
        if (typeof payload !== "object" || payload === null) {
          return new Response("Invalid JSON body", { status: 400 });
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const op = params.operation;

        try {
          switch (op) {
            case "camera-credentials": {
              const cameraId = uuid.parse(payload["camera_id"]);
              const { data, error } = await supabaseAdmin
                .from("camera_credentials")
                .select("username,password")
                .eq("camera_id", cameraId)
                .maybeSingle();
              if (error) throw error;
              return json({ username: data?.username ?? null, password: data?.password ?? null });
            }

            case "camera-runtime": {
              const cameraId = uuid.parse(payload["camera_id"]);
              const patch = z
                .object({
                  status: z.string().max(32),
                  fps: z.number().int().min(0).max(1000),
                  last_heartbeat_at: z.string().max(64).optional(),
                })
                .parse(payload["patch"]);
              const { error } = await supabaseAdmin
                .from("cameras")
                .update(patch as never)
                .eq("id", cameraId);
              if (error) throw error;
              return json({ ok: true });
            }

            case "service-health": {
              const row = z
                .object({
                  service: z.literal("ai"),
                  online: z.boolean(),
                  is_demo: z.boolean(),
                  payload: z.record(z.string(), z.unknown()),
                  updated_at: z.string().max(64),
                })
                .parse(payload["row"]);
              const { error } = await supabaseAdmin
                .from("service_health")
                .upsert(row as never, { onConflict: "service" });
              if (error) throw error;
              return json({ ok: true });
            }

            case "snapshot-upload": {
              const input = z
                .object({
                  object_path: z.string().min(1).max(300),
                  content_type: z.string().min(1).max(100),
                  bucket: z.string().min(1).max(64),
                  data_base64: z.string().min(1).max(20_000_000),
                })
                .parse(payload);
              const bytes = Uint8Array.from(atob(input.data_base64), (c) => c.charCodeAt(0));
              const { error } = await supabaseAdmin.storage
                .from(input.bucket)
                .upload(input.object_path, bytes, {
                  contentType: input.content_type,
                  upsert: true,
                });
              if (error) throw error;
              return json({ object_path: input.object_path });
            }

            case "event-insert": {
              const row = z.record(z.string(), z.unknown()).parse(payload["row"]);
              const { error } = await supabaseAdmin.from("events").insert(row as never);
              if (isConflict(error)) return json({ duplicate: true }, 409);
              if (error) throw error;
              return json({ ok: true });
            }

            case "event-snapshot": {
              const eventId = uuid.parse(payload["event_id"]);
              const snapshotPath = z.string().min(1).max(300).parse(payload["snapshot_path"]);
              const { error } = await supabaseAdmin
                .from("events")
                .update({ snapshot_path: snapshotPath })
                .eq("id", eventId);
              if (error) throw error;
              return json({ ok: true });
            }

            case "event-subject-insert": {
              const row = z.record(z.string(), z.unknown()).parse(payload["row"]);
              const { error } = await supabaseAdmin.from("event_subjects").insert(row as never);
              if (isConflict(error)) return json({ duplicate: true }, 409);
              if (error) throw error;
              return json({ ok: true });
            }

            case "session-subject-row-id": {
              const sessionId = uuid.parse(payload["exam_session_id"]);
              const number = z.number().int().min(1).parse(payload["subject_number"]);
              const { data, error } = await supabaseAdmin
                .from("session_subjects")
                .select("id")
                .eq("exam_session_id", sessionId)
                .eq("subject_number", number)
                .maybeSingle();
              if (error) throw error;
              return json({ id: data?.id ?? null });
            }

            case "session-subject-rows": {
              const sessionId = uuid.parse(payload["exam_session_id"]);
              const { data, error } = await supabaseAdmin
                .from("session_subjects")
                .select("id,subject_number")
                .eq("exam_session_id", sessionId);
              if (error) throw error;
              return json({ rows: data ?? [] });
            }

            case "session-subject-history": {
              const sessionId = uuid.parse(payload["exam_session_id"]);
              const { data, error } = await supabaseAdmin
                .from("session_subjects")
                .select(
                  "subject_number,first_seen_at,last_seen_at,lifecycle_status,camera_id," +
                    "last_bbox_x,last_bbox_y,last_bbox_width,last_bbox_height," +
                    "velocity_x,velocity_y,motion_updated_at",
                )
                .eq("exam_session_id", sessionId)
                .neq("lifecycle_status", "ended")
                .order("subject_number");
              if (error) throw error;
              return json({ rows: data ?? [] });
            }

            case "allocate-subject-number": {
              const sessionId = uuid.parse(payload["exam_session_id"]);
              const { data, error } = await supabaseAdmin.rpc(
                "allocate_session_subject_number",
                { _exam_session_id: sessionId },
              );
              if (error) throw error;
              const value = Array.isArray(data) ? data[0] : data;
              if (value === null || value === undefined) {
                return new Response("Allocation returned no value", { status: 502 });
              }
              return json({ subject_number: Number(value) });
            }

            case "session-subject-upsert": {
              const row = z.record(z.string(), z.unknown()).parse(payload["row"]);
              const { data, error } = await supabaseAdmin
                .from("session_subjects")
                .upsert(row as never, { onConflict: "exam_session_id,subject_number" })
                .select("id")
                .maybeSingle();
              if (error) throw error;
              return json({ id: data?.id ?? null });
            }

            case "subject-track-open": {
              const row = z.record(z.string(), z.unknown()).parse(payload["row"]);
              const { error } = await supabaseAdmin
                .from("session_subject_tracks")
                .insert(row as never);
              if (isConflict(error)) return json({ duplicate: true }, 409);
              if (error) throw error;
              return json({ ok: true });
            }

            case "subject-track-close": {
              const input = z
                .object({
                  exam_session_id: uuid,
                  raw_tracking_id: z.string().min(1).max(128),
                  ended_at: z.string().min(1).max(64),
                  end_reason: z.string().max(64).nullable().optional(),
                })
                .parse(payload);
              const { error } = await supabaseAdmin
                .from("session_subject_tracks")
                .update({ ended_at: input.ended_at, end_reason: input.end_reason ?? null })
                .eq("exam_session_id", input.exam_session_id)
                .eq("raw_tracking_id", input.raw_tracking_id)
                .is("ended_at", null);
              if (error) throw error;
              return json({ ok: true });
            }

            case "exam-session-runtime": {
              const sessionId = uuid.parse(payload["exam_session_id"]);
              const patch = z
                .object({
                  status: z.string().max(32),
                  started_at: z.string().max(64).optional(),
                  ended_at: z.string().max(64).optional(),
                })
                .parse(payload["patch"]);
              const { error } = await supabaseAdmin
                .from("exam_sessions")
                .update(patch as never)
                .eq("id", sessionId);
              if (error) throw error;
              return json({ ok: true });
            }

            case "exam-session-transition": {
              const sessionId = uuid.parse(payload["exam_session_id"]);
              const expectedStatus = z.string().max(32).parse(payload["expected_status"]);
              const patch = z
                .object({
                  status: z.string().max(32),
                  started_at: z.string().max(64).optional(),
                  ended_at: z.string().max(64).optional(),
                })
                .parse(payload["patch"]);
              const { data, error } = await supabaseAdmin
                .from("exam_sessions")
                .update(patch as never)
                .eq("id", sessionId)
                .eq("status", expectedStatus)
                .select("id");
              if (error) throw error;
              return json({ transitioned: (data ?? []).length > 0 });
            }

            default:
              return new Response("Unknown operation", { status: 404 });
          }
        } catch (error) {
          if (error instanceof z.ZodError) {
            return new Response("Invalid payload", { status: 400 });
          }
          const message = error instanceof Error ? error.message : "relay operation failed";
          if (isConflict({ message })) return json({ duplicate: true }, 409);
          console.error(`[ai-relay] ${op} failed`);
          return new Response("Relay operation failed", { status: 502 });
        }
      },
    },
  },
});
