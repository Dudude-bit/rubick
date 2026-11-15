import { ProblemSummary } from "@/components/object/detail-blocks";
import type { PodInfo } from "@/generated/types";
import { useT } from "@/i18n/useT";
import { probeFailureHeadline } from "@/lib/probe-failure";
import { FindingLine, ProbeFailureDetail } from "../-object/FindingLine";
import { useListedItems } from "../-object/problem";
import { itemFinding } from "../-object/item-finding";

/**
 * What the Pods row carries about a pod whose own status names no cause, as
 * the pod's page leads with it: a probe failing between restarts reads
 * "Running" and only its events and the shell know why.
 */
export function PodListedFindings({ pod }: { pod: PodInfo }) {
  const t = useT();
  const items = useListedItems("Pod", pod.namespace, pod.name, true) ?? [];
  if (items.length === 0) return null;
  return (
    <div className="mt-3 flex flex-col gap-2" data-testid="listed-findings">
      {items.map((item) => {
        const probe = item.detail?.says === "probe" ? item.detail : null;
        const finding = itemFinding(
          probe
            ? { ...item, reason: probeFailureHeadline(probe.failure, t) }
            : item,
          t
        );
        return (
          <ProblemSummary
            key={item.key}
            tone={finding.tone === "err" ? "err" : "warn"}
            headline={finding.title}
            detail={
              probe ? (
                <ProbeFailureDetail pod={pod} failure={probe.failure} />
              ) : (
                finding.detail || null
              )
            }
          />
        );
      })}
    </div>
  );
}

/** What opens a workload from another object, from the row's fact, where the peek's own read of it failed. */
export function ListedFindingLines({
  kind,
  namespace,
  name,
}: {
  kind: string;
  namespace: string;
  name: string;
}) {
  const t = useT();
  const items = (useListedItems(kind, namespace, name, true) ?? []).filter(
    (item) => item.kind !== item.opens.kind
  );
  return items.map((item) => (
    <FindingLine key={item.key} finding={itemFinding(item, t)} />
  ));
}
