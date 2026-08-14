import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { parseLocateReply } from "@/lib/subject-locate";

/**
 * Locate ONE existing anonymous exam subject.
 *
 * Read-only by contract: it asks the AI service where an already-persisted
 * subject was last actually observed. It never creates, renumbers, recovers or
 * resolves an identity, and a reply that cannot be verified is a failure rather
 * than a highlight drawn at a guessed position.
 */

const input = z.object({
  examSessionId: z.string().uuid(),
  subjectNumber: z.number().int().min(1),
});

export const locateExamSubject = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) => input.parse(data))
  .handler(async ({ data }) => {
    const { aiServiceCall } = await import("@/lib/ai-service.server");
    const result = await aiServiceCall(
      `/exam-sessions/${data.examSessionId}/subjects/${data.subjectNumber}/locate`,
      "GET",
    );
    if (!result.ok) throw new Error(`The subject could not be located. ${result.message}`);
    const parsed = parseLocateReply(result.body, data);
    if (!parsed.ok) throw new Error(parsed.message);
    return parsed.value;
  });
