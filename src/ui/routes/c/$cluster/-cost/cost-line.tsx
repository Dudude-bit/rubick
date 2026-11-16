/**
 * One object's cost on its own page: the namespace's read and the cluster's
 * total, never the whole picture, and the number read through `costOf` off
 * the same picture the Cost page draws its row from.
 */
import { useMemo } from "react";

import type { T } from "@/i18n/useT";
import { useT } from "@/i18n/useT";
import { sameKey, type CostTarget } from "@/lib/cost";
import { overRequested, workloadEfficiency } from "@/lib/efficiency";
import { useCost, useWorkloadUsage, type CostState } from "@/hooks/useCost";
import { cn } from "@/lib/utils";
import { costLineWords, efficiencyWords, troubleWords } from "./cost-words";

/** What the line says outside a picture; `null` draws nothing. */
function waitingWords(
  cost: Exclude<CostState, { state: "picture" }>,
  t: T
): string | null {
  switch (cost.state) {
    case "loading":
    case "nothing":
      return null;
    case "supplier":
      return troubleWords(cost.trouble, t);
    case "basisFailed":
      return t("cost", "lineUnread");
  }
}

function Line({
  words,
  tone,
  testId,
}: {
  words: string;
  tone?: "warn";
  testId: string;
}) {
  const t = useT();
  return (
    <div
      className="grid grid-cols-[92px_minmax(0,1fr)] items-baseline gap-3 px-1.5 py-0.5"
      data-testid={testId}
    >
      <span className="text-[11px] text-fg-mut">{t("nav", "cost")}</span>
      <span
        className={cn(
          "text-[11px]",
          tone === "warn" ? "text-warn" : "text-fg-mut"
        )}
      >
        {words}
      </span>
    </div>
  );
}

function useLine(target: CostTarget) {
  const t = useT();
  const namespaces = useMemo(() => [target.namespace], [target.namespace]);
  const { cost } = useCost(namespaces, { detail: true });
  if (cost.state === "picture")
    return {
      cost,
      words: costLineWords(cost.picture, target, t),
      tone: undefined,
    };
  const words = waitingWords(cost, t);
  return { cost, words, tone: words === null ? undefined : ("warn" as const) };
}

export function NamespaceCostLine({ namespace }: { namespace: string }) {
  const { words, tone } = useLine({ namespace });
  if (words === null) return null;
  return <Line words={words} tone={tone} testId="namespace-cost" />;
}

export function WorkloadCostLine({
  group,
  kind,
  name,
  namespace,
  billedTo = null,
}: {
  group: string;
  kind: string;
  name: string;
  namespace: string;
  /**
   * The workload this one's pods are billed to: a Job a CronJob made is
   * one run of the CronJob, and the cost is the CronJob's row.
   */
  billedTo?: { group: string; kind: string; name: string } | null;
}) {
  const t = useT();
  const billed = billedTo && [billedTo.group, billedTo.kind, billedTo.name];
  const target = useMemo(
    () =>
      billed
        ? { namespace, group: billed[0], kind: billed[1], name: billed[2] }
        : { namespace, group, kind, name },
    // By what it names: the page builds `billedTo` afresh on every render.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [namespace, group, kind, name, billed?.join("/")]
  );
  const line = useLine(target);
  const { cost, tone } = line;
  const words =
    billedTo && line.words !== null
      ? t("cost", "lineBilledTo", {
          kind: billedTo.kind,
          name: billedTo.name,
          line: line.words,
        })
      : line.words;
  const row =
    cost.state === "picture"
      ? cost.picture.workloads.find((w) => sameKey(w.key, target))
      : undefined;
  const keys = useMemo(() => (row ? [row.key] : null), [row]);
  const usage = useWorkloadUsage(keys ? [namespace] : null, keys);
  if (words === null) return null;
  const efficiency = row && workloadEfficiency(usage, row.key, row.requests);
  return (
    <>
      <Line words={words} tone={tone} testId="workload-cost" />
      {efficiency && (
        <div
          className="grid grid-cols-[92px_minmax(0,1fr)] items-baseline gap-3 px-1.5 py-0.5"
          data-testid="workload-efficiency"
        >
          <span className="text-[11px] text-fg-mut">
            {t("cost", "efficiency")}
          </span>
          <span className="text-[11px] text-fg-mut">
            {(["cpu", "memory"] as const).map((resource, i) => (
              <span
                key={resource}
                className={cn(
                  overRequested(efficiency[resource]) && "text-warn"
                )}
              >
                {i > 0 && " · "}
                {t("cost", resource)} {efficiencyWords(efficiency[resource], t)}
              </span>
            ))}
          </span>
        </div>
      )}
    </>
  );
}
