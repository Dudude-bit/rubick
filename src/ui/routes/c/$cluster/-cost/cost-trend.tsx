/**
 * How the cost per hour moved over 6 hours, a day or a week, where a
 * Prometheus holds the history. An estimate's trend is the entered prices
 * over what kube-state-metrics says the cluster held then.
 */
import { lazy, Suspense, useState } from "react";

import { Section, SectionHeader } from "@/components/ui/section";
import { useShareCaveat } from "@/components/share/screen-share";
import { COST_RANGES, type CostRange } from "@/integrations";
import { useT } from "@/i18n/useT";
import { currencyOf, type CostPicture } from "@/lib/cost";
import { cn, formatTimeUnit } from "@/lib/utils";
import { useCostTrend, type TrendState } from "@/hooks/useCost";
import { BAND_H } from "../-usage/band-frame";

const CostTrendChart = lazy(() => import("./cost-trend-chart"));

const RANGE_WORDS: Record<CostRange, () => string> = {
  "6h": () => formatTimeUnit(6, "hour"),
  "24h": () => formatTimeUnit(24, "hour"),
  "7d": () => formatTimeUnit(7, "day"),
};

function step(seconds: number): string {
  return seconds % 3600 === 0
    ? formatTimeUnit(seconds / 3600, "hour")
    : formatTimeUnit(Math.round(seconds / 60), "minute");
}

export function CostTrend({
  picture,
  namespaces,
}: {
  picture: CostPicture;
  namespaces: string[] | null;
}) {
  const t = useT();
  const [range, setRange] = useState<CostRange>("24h");
  const estimate = picture.source.kind === "estimate";
  const trend = useCostTrend(
    namespaces,
    range,
    picture.source.kind === "estimate" ? picture.source.prices : null
  );
  const said = trendWords(trend, estimate, t);
  useShareCaveat(trend.state === "failed" ? said : null);

  return (
    <Section>
      <SectionHeader
        title={t("cost", "trendTitle")}
        description={
          trend.state === "read" && trend.trend.points.length > 0
            ? t("cost", "trendCaption", { step: step(trend.trend.stepSeconds) })
            : undefined
        }
        actions={
          trend.state !== "noSupplier" && (
            <div className="flex items-center gap-0.5" role="group">
              {COST_RANGES.map((candidate) => (
                <button
                  key={candidate}
                  type="button"
                  aria-pressed={range === candidate}
                  onClick={() => setRange(candidate)}
                  className={cn(
                    "h-6 whitespace-nowrap rounded px-1.5 font-mono text-[11px] transition-colors hover:bg-hover",
                    range === candidate ? "bg-sel text-fg" : "text-fg-mut"
                  )}
                >
                  {RANGE_WORDS[candidate]()}
                </button>
              ))}
            </div>
          )
        }
      />
      {trend.state === "read" && trend.trend.points.length > 0 ? (
        <div className="px-1.5 py-2">
          <Suspense fallback={<div style={{ height: BAND_H }} />}>
            <CostTrendChart
              points={trend.trend.points}
              currency={currencyOf(picture)}
            />
          </Suspense>
        </div>
      ) : (
        <p
          className={cn(
            "px-1.5 py-3 text-xs",
            trend.state === "failed" ? "text-warn" : "text-fg-mut"
          )}
          role={trend.state === "reading" ? "status" : undefined}
          data-testid="cost-trend-note"
        >
          {said}
        </p>
      )}
    </Section>
  );
}

const TREND_WORDS: Record<
  TrendState["state"],
  (trend: TrendState, estimate: boolean, t: ReturnType<typeof useT>) => string
> = {
  noSupplier: (_, __, t) => t("cost", "trendNoSupplier"),
  reading: (_, __, t) => t("action", "reading"),
  failed: (trend, _, t) =>
    trend.state === "failed"
      ? t("cost", "trendFailed", { endpoint: trend.endpoint, said: trend.said })
      : "",
  read: (_, estimate, t) =>
    t("cost", estimate ? "trendEmptyEstimate" : "trendEmptyOpenCost"),
};

function trendWords(
  trend: TrendState,
  estimate: boolean,
  t: ReturnType<typeof useT>
): string {
  return TREND_WORDS[trend.state](trend, estimate, t);
}
