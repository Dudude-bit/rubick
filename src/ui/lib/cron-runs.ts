import type { JobInfo } from "@/generated/types";
import { commands } from "@/lib/commands";

export const cronJobRunsKey = (
  namespace: string | undefined,
  name: string | undefined
) => ["cronjob-jobs", namespace, name] as const;

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
  // The list command carries no owner references, so the naming
  // convention the controller uses is the only link available.
  return all.filter((job) => job.name.startsWith(`${name}-`));
}
