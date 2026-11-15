import { ProblemSummary } from "@/components/object/detail-blocks";
import type { PodInfo } from "@/generated/types";
import { useT, type T } from "@/i18n/useT";
import type { AttentionItem } from "@/lib/attention";
import type { Finding } from "@/lib/governance";
import { probeFailureHeadline } from "@/lib/probe-failure";
import { detailWords } from "../-overview/health-share";
import { FindingLine, ProbeFailureDetail } from "../-object/FindingLine";
import { useListedItems } from "../-object/problem";

const itemFinding = (item: AttentionItem, t: T): Finding => ({
  tone: item.tone,
  title: item.reason,
  detail: detailWords(item.detail, t) ?? "",
});

/**
 * What the Pods row carries about a pod whose own status names no cause, as
 * the pod's page leads with it: a probe failing between restarts reads
 * "Running" and only its events and the shell know why.
 */
export function PodListedFindings({ pod }: { pod: PodInfo }) {
  const t = useT();
  const items = useListedItems("Pod", pod.namespace, pod.name, true) ?? [];
  if (items.length === 0) return null;
  // A finding kept over a read that no longer answers is last known, as the chip says.
  const kept = (item: AttentionItem, headline: string) =>
    item.stale
      ? `${headline} · ${t("cluster", "problemNotRechecked")}`
      : headline;
  return (
    <div className="mt-3 flex flex-col gap-2" data-testid="listed-findings">
      {items.map((item) =>
        item.detail?.says === "probe" ? (
          <ProblemSummary
            key={item.key}
            tone={item.stale ? "warn" : item.tone}
            headline={kept(item, probeFailureHeadline(item.detail.failure, t))}
            detail={
              <ProbeFailureDetail pod={pod} failure={item.detail.failure} />
            }
          />
        ) : (
          <ProblemSummary
            key={item.key}
            tone={item.stale ? "warn" : item.tone}
            headline={kept(item, item.reason)}
            detail={detailWords(item.detail, t)}
          />
        )
      )}
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
