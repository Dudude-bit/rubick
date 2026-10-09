import { useObjectConnections } from "@/hooks/useConnections";
import { useT } from "@/i18n/useT";
import { governanceFindings } from "@/lib/governance-findings";
import type { Rollout } from "@/generated/types";
import { FindingLine } from "../-object/FindingLine";
import { RolloutSummary } from "../-object/RolloutSummary";

/**
 * What the workload's page says first, said first here too: the rollout
 * verdict and every autoscaler or budget finding, read through the same two
 * readers. The peek used to show a green Ready over a Deployment whose page
 * said its HPA could not read metrics.
 */
export function WorkloadDiagnosis({
  kind,
  name,
  namespace,
  rollout,
}: {
  kind: string;
  name: string;
  namespace: string;
  rollout: Rollout;
}) {
  const t = useT();
  // The page's key, so an open page or the traffic block answers from cache.
  const connections = useObjectConnections(kind, name, namespace);
  const findings = governanceFindings(connections.data, t);
  return (
    <div className="flex flex-col pt-2" data-testid="workload-diagnosis">
      <RolloutSummary rollout={rollout} subject={{ kind, name, namespace }} />
      {findings.map((finding) => (
        <FindingLine key={finding.title} finding={finding} />
      ))}
    </div>
  );
}
