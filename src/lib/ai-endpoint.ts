/**
 * Pure classification of the configured AI service endpoint.
 *
 * The Python AI service runs on the operator's own laptop, next to the camera.
 * The PUBLISHED cloud app cannot reach `127.0.0.1` or a LAN address, so an
 * endpoint like that can only ever work while the console itself is being run
 * on that same machine. This module states that fact truthfully instead of
 * letting the console pretend localhost is reachable.
 *
 * Camera credentials and RTSP URLs are never part of this: only the operator's
 * own admin-configured service origin is classified.
 */

export type AiEndpointReach =
  /** Nothing configured in Settings yet. */
  | "unset"
  /** Not a usable absolute http(s) URL. */
  | "invalid"
  /** Loopback / LAN / .local: reachable only from the operator's own machine. */
  | "local_only"
  /** A public hostname the cloud app can actually resolve and call. */
  | "public";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"]);

function isPrivateHost(host: string): boolean {
  if (LOOPBACK.has(host)) return true;
  if (host.endsWith(".local") || host.endsWith(".localhost")) return true;
  // A bare hostname with no dot can never be resolved from the public internet.
  if (!host.includes(".") && !host.includes(":")) return true;
  const parts = host.split(".");
  if (parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part))) {
    const [a, b] = parts.map((part) => Number(part)) as [number, number, number, number];
    if (a === 10 || a === 127) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
  }
  return false;
}

/** Normalizes and classifies the admin-configured AI service URL. */
export function classifyAiEndpoint(raw: string | null | undefined): AiEndpointReach {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") return "unset";
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return "invalid";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "invalid";
  if (url.username !== "" || url.password !== "") return "invalid";
  return isPrivateHost(url.hostname.toLowerCase()) ? "local_only" : "public";
}

/**
 * Operator-facing explanation for each classification. Deliberately names the
 * exact configuration field, and never claims a private address will work from
 * the published app.
 */
export const AI_ENDPOINT_GUIDANCE: Record<AiEndpointReach, string | null> = {
  unset: "No AI service endpoint is configured. Live Monitoring cannot show any stream yet.",
  invalid: "This is not a usable http(s) service origin, so no stream can be requested.",
  local_only:
    "Private address. This only works while the console runs on the same machine as the AI service. " +
    "For the published app, expose the local AI service over a public HTTPS tunnel " +
    "(for example a Cloudflare Tunnel or ngrok URL) and paste that HTTPS URL here.",
  public: null,
};

/** Reason shown when a request to a private endpoint fails from the cloud app. */
export const AI_ENDPOINT_UNREACHABLE_MESSAGE =
  "The AI service endpoint is a private/loopback address, so the published app cannot reach it. " +
  "Publish the local AI service on a public HTTPS URL and set it as the AI service URL in Settings.";
