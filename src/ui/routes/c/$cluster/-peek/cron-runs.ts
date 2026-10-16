import { keepPreviousData } from "@tanstack/react-query";
import { useMemo } from "react";

import type { JobInfo } from "@/generated/types";
import { useLiveQuery } from "@/hooks/useLiveQuery";
import { useRefusals } from "@/hooks/useRefusals";
import { toldRuns } from "@/lib/create-refusal";
import { cronJobRunsKey, readCronJobRuns } from "@/lib/cron-runs";
import { STALE_TIMES } from "@/lib/refresh";

/** The Jobs a CronJob still holds, as its page and its peek read them. */
export function useCronJobRuns(
  namespace: string | undefined,
  name: string | undefined
) {
  return useLiveQuery({
    queryKey: cronJobRunsKey(namespace, name),
    queryFn: () =>
      name && namespace
        ? readCronJobRuns(name, namespace)
        : Promise.resolve([]),
    enabled: !!namespace && !!name,
    placeholderData: keepPreviousData,
    staleTime: STALE_TIMES.resourceList,
    refresh: "resourceList",
  });
}

const createdOf = (job: JobInfo) => Date.parse(job.createdAt ?? "") || 0;

/** The run started last, by when it was created: a run started by hand has no minute in its name. */
export const newestRun = (jobs: readonly JobInfo[]): JobInfo | null =>
  jobs.reduce<JobInfo | null>(
    (newest, job) =>
      !newest || createdOf(job) > createdOf(newest) ? job : newest,
    null
  );

/** Whether the newest run is one whose pods the API server refuses, as its row says it. */
export const lastRunRefused = (told: readonly JobInfo[]) =>
  newestRun(told)?.status === "FailedCreate";

/** Whether a CronJob's newest run is refused its pods, read through the runs and refusals its page shares. */
export function useLastRunRefused(
  namespace: string,
  name: string,
  enabled: boolean
): boolean {
  const runs = useCronJobRuns(namespace, name);
  const refusals = useRefusals(
    namespace,
    enabled && !!runs.data?.some((job) => job.status === "Pending")
  );
  return useMemo(
    () => lastRunRefused(toldRuns(runs.data ?? [], refusals)),
    [runs.data, refusals]
  );
}
