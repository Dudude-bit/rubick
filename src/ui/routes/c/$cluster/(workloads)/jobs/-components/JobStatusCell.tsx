import { StatusBadge } from "@/components/ui/status-badge";
import type { JobInfo } from "@/generated/types";
import { useT } from "@/i18n/useT";
import { ownStatusWord } from "@/lib/status-words";
import { RowCauseText } from "../../-components/RowCauseText";
import { jobVerdict, type RowCause } from "../../-components/row-cause";

/** The Job's word, with what it rests on: the pods a retry follows, or the controller's reason for giving up, then the cause its pods share. */
export function JobStatusCell({
  job,
}: {
  job: Pick<JobInfo, "status" | "failed" | "failure"> & {
    podsCause: RowCause;
  };
}) {
  const t = useT();
  return (
    <span className="inline-flex min-w-0 items-baseline gap-1.5">
      {/* The badge stays whole; what follows it gives way. */}
      <span className="flex-none">
        <StatusBadge status={job.status}>
          {ownStatusWord(job.status, t)}
        </StatusBadge>
      </span>
      {job.status === "Retrying" && (
        <span className="truncate text-[11px] tabular-nums text-warn">
          {t("count", "failedPods", { n: job.failed })}
        </span>
      )}
      {job.failure?.reason && (
        <span className="truncate font-mono text-[11px] text-fg-mut">
          {job.failure.reason}
        </span>
      )}
      <RowCauseText cause={job.podsCause} verdict={jobVerdict(job.status)} />
    </span>
  );
}
