import type { ReactNode } from "react";

import { ResourceRef } from "@/components/object/ResourceRef";
import { parts } from "@/i18n/parts";
import { useObjectConnections } from "@/hooks/useConnections";
import { useT } from "@/i18n/useT";
import { governanceFindings } from "@/lib/governance-findings";
import type { CronJobDetailInfo, Rollout } from "@/generated/types";
import { cronOutcome, outcomeWords } from "@/lib/cron-outcome";
import { TONE_TEXT } from "@/lib/tone";
import { formatDate } from "@/lib/utils";
import { rolloutSettled } from "@/lib/workload-status";
import { WorkloadPodsCause } from "../-object/CauseLine";
import { FindingLine } from "../-object/FindingLine";
import { RolloutSummary } from "../-object/RolloutSummary";
import { newestRun, useCronJobRuns, useLastRunRefused } from "./cron-runs";
import { usePeekOwnedPods } from "./peek-owned-pods";
import { StatusBadge } from "@/components/ui/status-badge";
import { useRefusal } from "@/hooks/useRefusals";
import { jobWord } from "@/lib/create-refusal";
import { ownStatusWord } from "@/lib/status-words";

/**
 * What the workload's page says first, said first here too: the cause its
 * pods share, the rollout verdict and every autoscaler or budget finding,
 * read through the same readers. The peek used to show a green Ready over a
 * Deployment whose page said its HPA could not read metrics.
 */
export function WorkloadDiagnosis({
  kind,
  name,
  namespace,
  rollout,
  detail,
}: {
  kind: string;
  name: string;
  namespace: string;
  rollout: Rollout;
  /** The workload as the peek read it, which says how to find its pods. */
  detail: unknown;
}) {
  const t = useT();
  // The page's key, so an open page or the traffic block answers from cache.
  const connections = useObjectConnections(kind, name, namespace);
  const findings = governanceFindings(connections.data, t);
  const settled = rolloutSettled(rollout);
  return (
    <div className="flex flex-col pt-2" data-testid="workload-diagnosis">
      <PodsCause
        target={{ kind, name, namespace }}
        detail={detail}
        settled={settled}
      />
      <RolloutSummary rollout={rollout} subject={{ kind, name, namespace }} />
      {findings.map((finding) => (
        <FindingLine key={finding.title} finding={finding} />
      ))}
    </div>
  );
}

/** The cause a workload's pods share, read only while it is not settled. */
export function PodsCause({
  target,
  detail,
  settled,
  lead,
  className = "mb-1",
}: {
  target: { kind: string; name: string; namespace: string };
  detail: unknown;
  settled: boolean;
  lead?: ReactNode;
  className?: string;
}) {
  const pods = usePeekOwnedPods(target, detail, !settled);
  const read = pods.error ? null : pods.data;
  const refused = usePodsRefused(target, detail, read, !settled);
  return (
    <WorkloadPodsCause
      pods={read}
      settled={settled}
      namespace={target.namespace}
      refused={refused}
      lead={lead}
      className={className}
    />
  );
}

/** What the API server refuses a peeked controller: a Deployment's own word for it, or what its events and pods say. */
function usePodsRefused(
  target: { kind: string; namespace: string },
  detail: unknown,
  pods: readonly { createdAt: string | null }[] | null | undefined,
  enabled: boolean
): string | null {
  const carried = (detail as { podsRefused?: string | null } | undefined)
    ?.podsRefused;
  const read = useRefusal(
    target.namespace,
    (detail as { uid?: string } | undefined)?.uid,
    pods,
    enabled && carried === undefined
  );
  return carried === undefined ? read : carried;
}

/** A Job's badge with its pods' refusal read beside it, as its row and page draw it. */
export function JobBadge({
  job,
}: {
  job: { name: string; namespace: string; uid: string; status: string };
}) {
  const t = useT();
  const pending = job.status === "Pending";
  const pods = usePeekOwnedPods(
    { kind: "Job", name: job.name, namespace: job.namespace },
    job,
    pending
  );
  const refused = useRefusal(
    job.namespace,
    job.uid,
    pods.error ? null : pods.data,
    pending
  );
  const status = jobWord(job.status, refused);
  return (
    <StatusBadge status={status}>
      {ownStatusWord(status, t) ?? status}
    </StatusBadge>
  );
}

/**
 * The cause the pods of a CronJob's newest run share, named by that run,
 * until a run completes: every run of reports failed for six days under a
 * page that never said why.
 */
export function LastRunCause({
  namespace,
  name,
  className,
}: {
  namespace: string;
  name: string;
  className?: string;
}) {
  const t = useT();
  const runs = useCronJobRuns(namespace, name);
  const run = runs.data ? newestRun(runs.data) : null;
  if (!run) return null;
  return (
    <PodsCause
      target={{ kind: "Job", name: run.name, namespace }}
      detail={run}
      settled={run.status === "Complete"}
      className={className}
      lead={parts(t("readings", "lastRunCause"), {
        run: (
          <ResourceRef
            kind="Job"
            name={run.name}
            namespace={namespace}
            showKind={false}
          />
        ),
      })}
    />
  );
}

/** A CronJob's last run as its row says it, red where the API server refuses that run's pods. */
export function LastRunValue({ cron }: { cron: CronJobDetailInfo }) {
  const t = useT();
  const refused = useLastRunRefused(cron.namespace, cron.name, cron.active > 0);
  const { word, tone } = outcomeWords(cronOutcome(cron, refused), t);
  const at = formatDate(cron.lastSchedule);
  return (
    <span className={tone ? TONE_TEXT[tone] : undefined}>
      {at ? `${at} · ${word}` : word}
    </span>
  );
}
