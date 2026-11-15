/**
 * The cells the breakdowns draw: an amount in the words its column shares,
 * and a workload's two efficiencies on two lines.
 */
import { useT } from "@/i18n/useT";
import { overRequested, type WorkloadEfficiency } from "@/lib/efficiency";
import { cn } from "@/lib/utils";
import { efficiencyWords, money, type Said } from "./cost-words";

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
  return (
    <span className="flex flex-col text-[11px] leading-tight">
      {(["cpu", "memory"] as const).map((resource) => {
        const e = efficiency[resource];
        return (
          <span
            key={resource}
            className={cn(
              e.state === "measured" ? "font-mono tabular-nums" : "text-fg-fnt",
              overRequested(e) && "text-warn"
            )}
            title={overRequested(e) ? t("cost", "overRequested") : undefined}
          >
            {t("cost", resource === "cpu" ? "cpu" : "memory")}{" "}
            {efficiencyWords(e, t)}
          </span>
        );
      })}
    </span>
  );
}
