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
import { totalUnknown } from "@/lib/cost";
import { cn } from "@/lib/utils";
import {
  efficiencyWords,
  money,
  share,
  usedLines,
  youngFor,
  type Said,
} from "./cost-words";

/** An amount that is no number: not known is a read that did not answer, and amber. */
const WORDS_TONE: Record<Extract<Said, string>, string> = {
  notKnown: "text-warn",
  notPriced: "text-fg-fnt",
  none: "text-fg-fnt",
};

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
    <span className={WORDS_TONE[value ?? "notPriced"]}>{words}</span>
  );
}

/**
 * A row's share: a figure, one there is no whole or no bound to take
 * (muted), or none because the row has no total of its own, toned as that
 * total is.
 */
export function ShareCell({ row }: { row: Parameters<typeof share>[0] }) {
  const t = useT();
  const tone =
    row.share === null
      ? WORDS_TONE[totalUnknown(row) ? "notKnown" : "notPriced"]
      : typeof row.share === "object"
        ? "font-mono tabular-nums"
        : "text-fg-mut";
  return <span className={tone}>{share(row, t)}</span>;
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
