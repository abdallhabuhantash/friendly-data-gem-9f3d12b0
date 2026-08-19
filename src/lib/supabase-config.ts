/**
 * Client-safe detection of the PUBLIC backend configuration.
 *
 * The generated Supabase browser client throws the moment it is first touched
 * when `VITE_SUPABASE_URL` / `VITE_SUPABASE_PUBLISHABLE_KEY` are absent. Route
 * guards (`/`, `/_authenticated`) touch it inside `beforeLoad`, so a local
 * checkout without those values crashed the router before any page rendered —
 * the root error boundary was the only thing left, and both of its buttons
 * navigate straight back into the same crash.
 *
 * This helper lets public routes detect the missing configuration and explain
 * it instead of failing opaquely. It contains no secrets and never touches the
 * privileged (service-role) client.
 */

export type PublicSupabaseConfig = { url: string; publishableKey: string };

function readEnv(name: string): string | undefined {
  const fromVite = (import.meta.env as Record<string, string | undefined>)[name];
  if (typeof fromVite === "string" && fromVite.trim() !== "") return fromVite;
  if (typeof process !== "undefined" && process.env) {
    const fromProcess = process.env[name.replace(/^VITE_/, "")];
    if (typeof fromProcess === "string" && fromProcess.trim() !== "") return fromProcess;
  }
  return undefined;
}

export function getPublicSupabaseConfig(): PublicSupabaseConfig | null {
  const url = readEnv("VITE_SUPABASE_URL");
  const publishableKey = readEnv("VITE_SUPABASE_PUBLISHABLE_KEY");
  if (!url || !publishableKey) return null;
  return { url, publishableKey };
}

export function hasPublicSupabaseConfig(): boolean {
  return getPublicSupabaseConfig() !== null;
}

export const MISSING_PUBLIC_SUPABASE_CONFIG_MESSAGE =
  "Backend configuration is missing. Add VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY to a local .env (or .env.local) file and restart the dev server.";
