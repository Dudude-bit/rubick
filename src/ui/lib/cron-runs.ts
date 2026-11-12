import type { JobInfo, PodInfo } from "@/generated/types";
import { commands } from "@/lib/commands";

export const cronJobRunsKey = (
  namespace: string | undefined,
  name: string | undefined
) => ["cronjob-jobs", namespace, name] as const;

/**
 * Whether a Job is one of a CronJob's runs. The list command carries no
 * owner references, so the name is the only link there is: the controller's
 * `<cronjob>-<minute>`, or whatever Run now was given after the same stem.
 */
export const isRunOf = (cronJob: string, job: string) =>
  job.startsWith(`${cronJob}-`);

/** Whether a pod is one of a CronJob's runs', by the Job that owns it. */
export const isPodOfRun = (cronJob: string, pod: Pick<PodInfo, "workload">) =>
  pod.workload?.kind === "Job" && isRunOf(cronJob, pod.workload.name);

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
  return all.filter((job) => isRunOf(name, job.name));
}
