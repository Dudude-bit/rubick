/**
 * The cells the breakdowns draw: an amount in the words its column shares,
 * and a workload's two efficiencies on two lines.
 */
import { useT } from "@/i18n/useT";
import {
  efficiencyWarns,
  overRequested,
  type Efficiency,
  type WorkloadEfficiency,
} from "@/lib/efficiency";
import { cn } from "@/lib/utils";
import {
  efficiencyWords,
  money,
  usedLines,
  youngFor,
  type Said,
} from "./cost-words";

export function Money({
  value,
  currency,
}: {
  value: Said | null | undefined;
  currency: string;
}) {
  const t = useT();
  const words = money(value, currency, t);
  return typeof value === "number" || (value && typeof value === "object") ? (
    <span className="font-mono tabular-nums">{words}</span>
  ) : (
    <span className="text-fg-fnt">{words}</span>
  );
}

export function EfficiencyCell({
  efficiency,
}: {
  efficiency: WorkloadEfficiency;
}) {
  const t = useT();
  const titleOf = (e: Efficiency) => {
    if (overRequested(e)) return t("cost", "overRequested");
    if (e.state !== "measured" || e.whole) return undefined;
    const age = youngFor(e, t);
    return age === null
      ? t("cost", "effUndated")
      : t("cost", "effYoung", { age });
  };
  return (
    <span className="flex flex-col text-[11px] leading-tight">
      {(["cpu", "memory"] as const).map((resource) => {
        const e = efficiency[resource];
        return (
          <span
            key={resource}
            className={cn(
              e.state === "measured" && "font-mono tabular-nums",
              efficiencyWarns(e)
                ? "text-warn"
                : e.state !== "measured" && "text-fg-fnt"
            )}
            title={titleOf(e)}
          >
            {t("cost", resource === "cpu" ? "cpu" : "memory")}{" "}
            {efficiencyWords(e, t)}
          </span>
        );
      })}
    </span>
  );
}

/** What one resource used: the average, and under it the peak. */
export function UsedCell({
  efficiency,
  kind,
}: {
  efficiency: Efficiency;
  kind: "cpu" | "memory";
}) {
  const t = useT();
  return (
    <span className="flex flex-col text-[11px] leading-tight">
      {usedLines(efficiency, kind, t).map((line) => (
        <span key={line}>{line}</span>
      ))}
    </span>
  );
}
