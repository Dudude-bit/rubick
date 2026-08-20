import {
  Loader2,
  CheckCircle2,
  XCircle,
  Clock,
  Trash2,
  RefreshCw,
} from "lucide-react";
import {
  useBackgroundJobStore,
  type BackgroundJob,
  type BackgroundJobType,
} from "@/stores/backgroundJobStore";
import { cn } from "@/lib/utils";
import { RealtimeAge } from "@/components/ui/realtime";
import {
  ACTIVITY_ROW,
  ActivityAction,
  ActivityEmpty,
  ActivityGroup,
} from "./primitives";
import { useT } from "@/i18n/useT";
import type { en } from "@/i18n/catalogue";

const JOB_TYPE_LABELS: Record<BackgroundJobType, keyof typeof en.action> = {
  delete: "delete",
  scale: "scale",
  restart: "restart",
  apply: "apply",
  rollback: "rollBack",
  cordon: "cordon",
  uncordon: "uncordon",
  drain: "drain",
};

function JobStatusIcon({ job }: { job: BackgroundJob }) {
  switch (job.status) {
    case "pending":
      return <Clock className="h-3.5 w-3.5 flex-none text-fg-fnt" />;
    case "running":
      return (
        <Loader2 className="h-3.5 w-3.5 flex-none animate-spin text-info" />
      );
    case "completed":
      return <CheckCircle2 className="h-3.5 w-3.5 flex-none text-ok" />;
    case "failed":
      return <XCircle className="h-3.5 w-3.5 flex-none text-err" />;
  }
}

function JobIdentity({ job }: { job: BackgroundJob }) {
  const t = useT();
  return (
    <span className="min-w-0 flex-1">
      <span className="block truncate text-fg-mid">
        {t("action", JOB_TYPE_LABELS[job.type])} {job.resourceType}
      </span>
      <span className="block truncate font-mono text-[11px] text-fg-fnt">
        {job.resourceName}
        {job.namespace && ` · ${job.namespace}`}
      </span>
      {job.status === "failed" && job.message && (
        <span className="block truncate text-[11px] text-err">
          {job.message}
        </span>
      )}
    </span>
  );
}

export function BackgroundJobsTab() {
  const t = useT();
  const { jobs, removeJob, clearCompleted } = useBackgroundJobStore();

  const activeJobs = jobs.filter(
    (job) => job.status === "pending" || job.status === "running"
  );
  const completedJobs = jobs.filter(
    (job) => job.status === "completed" || job.status === "failed"
  );

  if (jobs.length === 0) {
    return (
      <ActivityEmpty
        icon={RefreshCw}
        title={t("empty", "noBackgroundJobs")}
        hint={t("empty", "backgroundJobsHint")}
      />
    );
  }

  return (
    <div className="pb-3">
      {activeJobs.length > 0 && (
        <ActivityGroup
          title={t("activity", "running")}
          count={activeJobs.length}
        >
          {activeJobs.map((job) => (
            <div key={job.id} className={cn(ACTIVITY_ROW, "flex-col gap-1")}>
              <span className="flex w-full items-center gap-2.5">
                <JobStatusIcon job={job} />
                <JobIdentity job={job} />
              </span>
              {job.progress !== undefined && (
                <span className="h-[3px] w-full overflow-hidden rounded-sm bg-sel">
                  <span
                    className="block h-full bg-info"
                    style={{ width: `${job.progress}%` }}
                  />
                </span>
              )}
              {job.message && (
                <span className="w-full truncate text-[11px] text-fg-fnt">
                  {job.message}
                </span>
              )}
            </div>
          ))}
        </ActivityGroup>
      )}

      {completedJobs.length > 0 && (
        <ActivityGroup
          title={t("activity", "finished")}
          count={completedJobs.length}
          action={
            <ActivityAction onClick={clearCompleted}>
              {t("action", "clear")}
            </ActivityAction>
          }
        >
          {completedJobs.map((job) => (
            <div key={job.id} className={ACTIVITY_ROW}>
              <JobStatusIcon job={job} />
              <JobIdentity job={job} />
              <RealtimeAge
                timestamp={job.completedAt ?? job.createdAt}
                className="flex-none text-[11px] text-fg-fnt"
              />
              <ActivityAction
                aria-label={t("action", "dismissJob", {
                  job: t("action", JOB_TYPE_LABELS[job.type]),
                  name: job.resourceName,
                })}
                onClick={() => removeJob(job.id)}
              >
                <Trash2 className="h-3 w-3" />
              </ActivityAction>
            </div>
          ))}
        </ActivityGroup>
      )}
    </div>
  );
}
