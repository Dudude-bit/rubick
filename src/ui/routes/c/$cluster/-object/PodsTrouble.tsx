import { useMemo } from "react";

import { ObjectLink } from "@/components/object/ResourceRef";
import { ProblemSummary } from "@/components/object/detail-blocks";
import { useT } from "@/i18n/useT";
import { reasonWord, type AttentionItem } from "@/lib/attention";
import { ResourceType } from "@/lib/resource-registry";
import { detailWords } from "../-overview/health-share";

/** One line per thing its pods are failing: how many, what, and a link to each. */
export function PodsTroubleLines({
  pods,
}: {
  pods: readonly AttentionItem[] | null;
}) {
  const t = useT();
  const groups = useMemo(() => {
    const byReason = new Map<string, AttentionItem[]>();
    for (const item of pods ?? [])
      byReason.set(item.reason, [...(byReason.get(item.reason) ?? []), item]);
    return [...byReason.values()];
  }, [pods]);
  if (groups.length === 0) return null;
  return (
    <div className="mb-1 flex flex-col gap-2" data-testid="pods-trouble">
      {groups.map((group) => {
        const worst = group.find(({ tone }) => tone === "err") ?? group[0];
        const n = group.reduce((sum, item) => sum + (item.foldedPods ?? 1), 0);
        const named = group.filter((item) => item.kind === ResourceType.Pod);
        return (
          <ProblemSummary
            key={worst.reason}
            tone={worst.tone}
            headline={t("readings", "podsTroubled", {
              n,
              reason: reasonWord(worst, t),
            })}
            detail={detailWords(worst.detail, t, worst.foldedPods)}
            action={
              named.length > 0 && (
                <span className="flex flex-wrap gap-x-3 pl-1.5 text-caption">
                  {named.map((item) => (
                    <ObjectLink
                      key={item.key}
                      kind={ResourceType.Pod}
                      name={item.name}
                      namespace={item.namespace ?? undefined}
                      className="font-mono text-info hover:underline"
                    >
                      {item.name}
                    </ObjectLink>
                  ))}
                </span>
              )
            }
          />
        );
      })}
    </div>
  );
}
