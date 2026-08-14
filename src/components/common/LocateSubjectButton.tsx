import { Link } from "@tanstack/react-router";
import { Crosshair } from "lucide-react";
import { Button } from "@/components/ui/button";
import { locateSearch, locateTargetFor } from "@/lib/subject-locate";

/**
 * Entry point to "locate this subject" in the live monitoring console.
 *
 * It is only offered for an attribution that already links a persisted anonymous
 * subject to an exam session; it never guesses a subject for an unattributed
 * event, and it never claims the subject is currently visible.
 */
export function LocateSubjectButton({
  attribution,
  className,
}: {
  attribution: { examSessionId?: string | null; subjectNumber?: number | null };
  className?: string;
}) {
  const target = locateTargetFor(attribution);
  if (!target) return null;
  return (
    <Button asChild size="sm" variant="outline" className={className ?? "h-7 px-2 text-[11px]"}>
      <Link to="/monitoring" search={locateSearch(target)}>
        <Crosshair className="size-3" /> Locate
      </Link>
    </Button>
  );
}
