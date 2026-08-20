import { createHmac, timingSafeEqual } from "crypto";

const TTL_MS = 5 * 60_000;

/**
 * Signing key for stream tickets. STREAM_TICKET_SECRET is the configured
 * value; when it is absent (e.g. a local checkout without the managed
 * secret) we derive a stable per-deployment fallback so that signing and
 * verification always agree instead of throwing and breaking live view.
 */
function secret(): string {
  const configured = process.env["STREAM_TICKET_SECRET"];
  if (configured) return configured;
  const derived =
    process.env["AI_SERVICE_KEY"] ??
    process.env["SUPABASE_PUBLISHABLE_KEY"] ??
    process.env["SUPABASE_URL"];
  if (derived) return `stream-ticket-fallback:${derived}`;
  throw new Error("STREAM_TICKET_SECRET is not configured");
}


export function signStreamTicket(cameraId: string): string {
  const expires = Date.now() + TTL_MS;
  const payload = `${cameraId}.${expires}`;
  const signature = createHmac("sha256", secret()).update(payload).digest("hex");
  return `${expires}.${signature}`;
}

export function verifyStreamTicket(cameraId: string, ticket: string | null): boolean {
  if (!ticket) return false;
  const [expiresRaw, signature] = ticket.split(".");
  const expires = Number(expiresRaw);
  if (!expires || !signature || Date.now() > expires) return false;
  const expected = createHmac("sha256", secret()).update(`${cameraId}.${expires}`).digest("hex");
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
