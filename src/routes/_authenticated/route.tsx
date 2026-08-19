import { Outlet, createFileRoute, redirect, useRouterState } from "@tanstack/react-router";
import { AppSidebar } from "@/components/layout/AppSidebar";
import { supabase } from "@/integrations/supabase/client";
import { hasPublicSupabaseConfig } from "@/lib/supabase-config";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async () => {
    // Missing public backend config must land on /login (which explains it),
    // never on the root error boundary.
    if (!hasPublicSupabaseConfig()) throw redirect({ to: "/login" });
    try {
      const { data, error } = await supabase.auth.getUser();
      if (error || !data.user) throw redirect({ to: "/login" });
      return { user: data.user };
    } catch (caught) {
      if (caught != null && typeof caught === "object" && "isRedirect" in caught) throw caught;
      throw redirect({ to: "/login" });
    }
  },
  component: AuthenticatedLayout,
});

function AuthenticatedLayout() {
  const monitoring = useRouterState({
    select: (state) => state.location.pathname === "/monitoring",
  });
  return (
    <div className="flex min-h-screen w-full bg-background">
      {!monitoring && <AppSidebar />}
      <div className="flex min-w-0 flex-1 flex-col">
        <Outlet />
      </div>
    </div>
  );
}
