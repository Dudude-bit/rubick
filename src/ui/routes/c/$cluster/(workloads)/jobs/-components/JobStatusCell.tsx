import { StatusBadge } from "@/components/ui/status-badge";
import type { JobInfo } from "@/generated/types";
import { useT } from "@/i18n/useT";
import { ownStatusWord } from "@/lib/status-words";

/** The Job's word, with what it rests on: the pods a retry follows, or the controller's reason for giving up. */
export function JobStatusCell({
  job,
}: {
  job: Pick<JobInfo, "status" | "failed" | "failure">;
}) {
  const t = useT();
  return (
    <span className="inline-flex min-w-0 items-baseline gap-1.5">
      <StatusBadge status={job.status}>
        {ownStatusWord(job.status, t)}
      </StatusBadge>
      {job.status === "Retrying" && (
        <span className="text-[11px] tabular-nums text-warn">
          {t("count", "failedPods", { n: job.failed })}
        </span>
      )}
      {job.failure?.reason && (
        <span className="truncate font-mono text-[11px] text-fg-mut">
          {job.failure.reason}
        </span>
      )}
    </span>
  );
}
