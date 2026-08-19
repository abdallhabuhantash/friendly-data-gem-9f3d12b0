import { createFileRoute, isRedirect, redirect } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { hasPublicSupabaseConfig } from "@/lib/supabase-config";


export const Route = createFileRoute("/")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Vigilant Eye — AI Smart Surveillance" },
      {
        name: "description",
        content:
          "Command-center console for multi-camera AI monitoring and suspicious cheating activity detection.",
      },
      { property: "og:title", content: "Vigilant Eye — AI Smart Surveillance" },
      {
        property: "og:description",
        content:
          "Command-center console for multi-camera AI monitoring and suspicious cheating activity detection.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  beforeLoad: async () => {
    // Without public backend config, touching the Supabase client throws and the
    // router lands on the root error boundary. Send the visitor to /login, which
    // explains exactly what is missing.
    if (!hasPublicSupabaseConfig()) throw redirect({ to: "/login" });
    let signedIn = false;
    try {
      const { data } = await supabase.auth.getSession();
      signedIn = data.session !== null;
    } catch {
      signedIn = false;
    }
    throw redirect({ to: signedIn ? "/dashboard" : "/login" });

  },
  component: () => null,
});

