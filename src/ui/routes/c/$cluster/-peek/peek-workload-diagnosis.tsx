import { useObjectConnections } from "@/hooks/useConnections";
import { useT } from "@/i18n/useT";
import { governanceFindings } from "@/lib/governance-findings";
import type { Rollout } from "@/generated/types";
import { rolloutSettled } from "@/lib/workload-status";
import { WorkloadPodsCause } from "../-object/CauseLine";
import { FindingLine } from "../-object/FindingLine";
import { RolloutSummary } from "../-object/RolloutSummary";
import { usePeekOwnedPods } from "./peek-owned-pods";

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
  className = "mb-1",
}: {
  target: { kind: string; name: string; namespace: string };
  detail: unknown;
  settled: boolean;
  className?: string;
}) {
  const pods = usePeekOwnedPods(target, detail, !settled);
  return (
    <WorkloadPodsCause
      pods={pods.error ? null : pods.data}
      settled={settled}
      namespace={target.namespace}
      className={className}
    />
  );
}
