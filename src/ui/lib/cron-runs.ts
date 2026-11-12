import type { JobInfo, PodInfo } from "@/generated/types";
import { commands } from "@/lib/commands";

export const cronJobRunsKey = (
  namespace: string | undefined,
  name: string | undefined
) => ["cronjob-jobs", namespace, name] as const;

/**
 * Whether a Job is one of a CronJob's runs: the CronJob controls it. Its
 * name does not say: `backup-nightly-28901234` begins with `backup-` too,
 * and is another CronJob's.
 */
export const isRunOf = (cronJob: string, job: Pick<JobInfo, "cronJob">) =>
  job.cronJob === cronJob;

/** Whether a pod is one of a CronJob's runs', by the Job that owns it. */
export const isPodOfRun = (
  runs: readonly Pick<JobInfo, "name">[],
  pod: Pick<PodInfo, "workload">
) => {
  const owner = pod.workload;
  return owner?.kind === "Job" && runs.some((run) => run.name === owner.name);
};

/** The Jobs a CronJob still holds, as its page, its peek and its events read them. */
export async function readCronJobRuns(
  name: string,
  namespace: string
): Promise<JobInfo[]> {
  const all = await commands.listJobs({
    namespace,
    labelSelector: null,
    fieldSelector: null,
    limit: null,
  });
  return all.filter((job) => isRunOf(name, job));
}
