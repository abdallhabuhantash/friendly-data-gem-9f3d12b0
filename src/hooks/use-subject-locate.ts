import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { locateExamSubject } from "@/lib/subject-locate.functions";
import type { LocateTarget, SubjectLocateResult } from "@/lib/subject-locate";

/**
 * Polls the AI service for the current position of ONE anonymous subject.
 *
 * The result is measured, never cached optimistically: an outdated highlight is
 * worse than no highlight, so the previous answer is not kept across targets and
 * a failed read is surfaced as an error state instead of a stale box.
 */
export function useSubjectLocate(target: LocateTarget | null) {
  const locate = useServerFn(locateExamSubject);
  return useQuery<SubjectLocateResult>({
    queryKey: ["subject-locate", target?.examSessionId ?? "", target?.subjectNumber ?? 0],
    queryFn: () =>
      locate({
        data: { examSessionId: target!.examSessionId, subjectNumber: target!.subjectNumber },
      }),
    enabled: target !== null,
    // Modest live cadence: one target = one request; no polling without a target.
    refetchInterval: 900,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
}
