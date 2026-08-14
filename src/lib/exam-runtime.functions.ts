import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { parseEndReply, parseStartReply } from "@/lib/exam-runtime-contract";


/**
 * Start / End Exam Session.
 *
 * Arming is deliberately explicit: handing out exam papers at the beginning of
 * an exam looks exactly like a paper exchange, so monitoring stays unarmed
 * until an administrator starts the session (see
 * `docs/exam-session-identity-contract.md` §11).
 *
 * The web app never fakes an armed session: it asks the local AI service, and
 * the session only becomes `active` because the AI service confirmed it and
 * wrote that state itself. If the AI service is not reachable or not
 * configured, the truthful failure is reported and nothing changes.
 */

const input = z.object({ examSessionId: z.string().uuid() });

async function aiServiceCall(path: string) {
  const { aiServiceCall: call } = await import("@/lib/ai-service.server");
  return call(path, "POST");
}

async function assertAdministrator(context: { supabase: unknown; userId: string }) {
  const supabase = context.supabase as {
    rpc: (
      name: string,
      args: Record<string, unknown>,
    ) => Promise<{ data: unknown; error: { message: string } | null }>;
  };
  const { data, error } = await supabase.rpc("has_role", {
    _user_id: context.userId,
    _role: "administrator",
  });
  if (error || data !== true)
    throw new Error("Only administrators can start or end an exam session.");
}

export const startExamSession = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) => input.parse(data))
  .handler(async ({ data, context }) => {
    await assertAdministrator(context);
    const result = await aiServiceCall(`/exam-sessions/${data.examSessionId}/arm`);
    if (!result.ok) throw new Error(`Monitoring was not started. ${result.message}`);
    const parsed = parseStartReply(result.body, data.examSessionId);
    if (!parsed.ok) throw new Error(`Monitoring was not confirmed. ${parsed.message}`);
    return parsed.value;
  });

export const endExamSession = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) => input.parse(data))
  .handler(async ({ data, context }) => {
    await assertAdministrator(context);
    const result = await aiServiceCall(`/exam-sessions/${data.examSessionId}/end`);
    if (!result.ok) throw new Error(`The session was not ended. ${result.message}`);
    const parsed = parseEndReply(result.body, data.examSessionId);
    if (!parsed.ok) throw new Error(`The end of the session was not confirmed. ${parsed.message}`);
    return parsed.value;
  });

