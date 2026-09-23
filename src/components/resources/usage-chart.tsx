/**
 * One measure, over the window this app has watched.
 *
 * Drawn with `recharts`. The palette still comes from the role tokens and
 * never from JS: the series inherits `currentColor` from a `text-*` class on
 * the wrapper — gradient stops included — and the fixed roles are handed to
 * recharts as the CSS-variable strings SVG presentation attributes accept
 * (`hsl(var(--warn))`), which resolve per theme from `index.css` like every
 * other mark in the app.
 *
 * CPU and memory stay two bands. One plot with two y-axes would put the
 * crossing point of the lines on screen, and that point means nothing.
 */
import * as React from "react";
import { PerfProfiler } from "@/lib/perf-profiler";
import type { DeclaredPoint } from "@/integrations";
import { UnitValue } from "@/components/ui/metric-value";
import { formatQuantity } from "@/lib/metric-format";
import {
  bucketize,
  chartMax,
  clockOf,
  latestValue,
  peakOf,
  type UsagePoint,
  type UsageSample,
} from "@/lib/usage-history";
import { useT } from "@/i18n/useT";
import type { en } from "@/i18n/catalogue";

/** A line this chart is allowed to say, by the name the catalogue gives it. */
export type EmptyKey = keyof typeof en.empty;

/**
 * Tall enough to read a shape off. The 42px band this replaces turned every
 * series into a flat rule: at that height a doubling of load is four pixels.
 */
export const BAND_H = 56;

const Band = React.lazy(() => import("./usage-band"));

/**
 * What a band says before it has two readings to join, and what it says when
 * nothing declares a ceiling.
 *
 * Keys rather than sentences: both are read by somebody looking at a chart,
 * and a chart is not the place the app is allowed to change language.
 */
export const WATCHING_NOTE = "watchingFromNow" as const;
export const NO_LIMIT_NOTE = "noLimitSet" as const;

export interface UsageChartProps {
  label: string;
  type: "cpu" | "memory";
  samples: readonly UsageSample[];
  /** The declared ceiling, or null when the object has none. */
  limit: number | null;
  /** What the ceiling is called here — a pod has limits, a node a capacity. */
  limitNoun?: "limitWord" | "capacityWord";
  /**
   * Sentence for the no-limit case. Defaulted here rather than only at the
   * call site: a band that silently omitted it would be the very bug this
   * replaces — a scale with no stated denominator.
   */
  noLimitNote?: EmptyKey | null;
  /** Live value, used before the buffer has anything to draw. */
  current: number | null;
  /** Set when the block is saying the same thing once for both bands. */
  suppressNote?: boolean;
  /**
   * Whether anything is running behind this window.
   *
   * False on a finished Job or a scaled-to-zero Deployment, where the whole
   * series is a supplier's record of a workload that has since stopped. The
   * last reading in it is then the last one there ever was, and printing it
   * bare — `12Mi / 64Mi · 19%` — tells the reader the workload is using that
   * much right now. So the number on the right becomes the window's peak and
   * says which it is, and "watching from now" is never claimed about a
   * window nobody is watching.
   */
  live?: boolean;
  /**
   * A supplier's window is on screen rather than the watched buffer. The
   * number on the right then carries the window's average and peak as well,
   * because "now" alone says nothing about a day.
   */
  ranged?: boolean;
  /** What the object asks for today, drawn as a line like the ceiling is. */
  request?: number | null;
  /**
   * Requests and limits as they stood through the window. `null` when the
   * supplier keeps no such record: the lines are then today's figures drawn
   * flat, and labelled "now". Absent when nothing was asked.
   */
  declared?: {
    request: readonly DeclaredPoint[];
    limit: readonly DeclaredPoint[];
  } | null;
}

/** Average of what was drawn; `null` when nothing was. */
function averageOf(points: readonly UsagePoint[]): number | null {
  let sum = 0;
  let n = 0;
  for (const point of points) {
    if (point.v !== null) {
      sum += point.v;
      n += 1;
    }
  }
  return n === 0 ? null : sum / n;
}

/**
 * A band, plus whichever sentence the data has earned: none when there is
 * a limit and a line, one when either is missing.
 */
export function UsageChart(props: UsageChartProps) {
  return (
    <PerfProfiler id="usage-chart">
      <UsageChartInner {...props} />
    </PerfProfiler>
  );
}

function UsageChartInner({
  label,
  type,
  samples,
  limit,
  limitNoun = "limitWord",
  noLimitNote = NO_LIMIT_NOTE,
  current,
  suppressNote = false,
  live = true,
  ranged = false,
  request = null,
  declared,
}: UsageChartProps) {
  const t = useT();
  const channel = type === "cpu" ? "cpuMillicores" : "memoryBytes";
  const points = React.useMemo(
    () => bucketize(samples, channel),
    [samples, channel]
  );

  const drawn = points.filter((point) => point.v !== null).length;
  const max = chartMax(points, limit);
  const value = live ? (latestValue(points) ?? current) : peakOf(points);
  const ratio =
    limit !== null && limit > 0 && value !== null ? value / limit : null;
  const average = ranged ? averageOf(points) : null;
  const peak = ranged && live ? peakOf(points) : null;
  const peakAt = peak === null ? null : points.find((p) => p.v === peak)?.t;

  return (
    <div>
      {/* The gutter has to clear the limit label, which sits in the band's
       *  own top margin — any tighter and it reads as a caption on the band
       *  above it. */}
      <div className="grid grid-cols-[92px_minmax(0,1fr)_150px] items-center gap-3 px-1.5 py-2">
        <span className="text-[11px] text-fg-mut">{label}</span>
        {/* No reading at all draws no band. A band with nothing in it is the
         *  empty plot this replaced, one size larger. */}
        {value === null && drawn === 0 ? (
          <span />
        ) : (
          <React.Suspense fallback={<div style={{ height: BAND_H }} />}>
            <Band
              points={points}
              drawn={drawn}
              max={max}
              limit={limit}
              request={request}
              declared={declared}
              type={type}
              label={label}
              limitNoun={limitNoun}
              live={live}
            />
          </React.Suspense>
        )}
        <span className="text-right text-[11px] text-fg-mut">
          {value === null ? (
            // The block only draws bands while metrics-server is available,
            // so a missing value here is the server having nothing to say
            // about this object — usually a container that is not running.
            <span
              className="text-fg-fnt"
              title={t("empty", "noMetricsReading")}
            >
              not reporting
            </span>
          ) : (
            <>
              {!live && <span className="text-fg-fnt">peak </span>}
              {live && ranged && <span className="text-fg-fnt">now </span>}
              <UnitValue value={formatQuantity(value, type)} />
              {limit !== null && limit > 0 && (
                <>
                  <span className="text-[0.85em] text-fg-fnt">/</span>
                  <UnitValue value={formatQuantity(limit, type)} />
                  {ratio !== null && (
                    <>
                      {" · "}
                      {Math.round(ratio * 100)}
                      <span className="text-[0.85em] text-fg-fnt">%</span>
                    </>
                  )}
                </>
              )}
            </>
          )}
        </span>
      </div>
      {ranged && average !== null && (
        <p className="-mt-1 pb-1 pr-1.5 text-right font-mono text-[10px] tabular-nums text-fg-fnt">
          {t("readings", "usageAvg", { value: formatQuantity(average, type) })}
          {peak !== null && (
            <>
              {" · "}
              {t("readings", "usagePeak", {
                value: formatQuantity(peak, type),
              })}
              {peakAt
                ? ` ${t("readings", "usageAt", { clock: clockOf(peakAt) })}`
                : ""}
            </>
          )}
        </p>
      )}
      <Note>
        {suppressNote || (drawn === 0 && value === null)
          ? null
          : drawn <= 1 && live
            ? t("empty", WATCHING_NOTE)
            : (limit === null || limit <= 0) && noLimitNote !== null
              ? t("empty", noLimitNote)
              : null}
      </Note>
    </div>
  );
}

/** Sits under the band, in the plot's own column. */
function Note({ children }: { children?: React.ReactNode }) {
  if (!children) return null;
  return (
    <p className="pb-1 pl-[104px] pr-1.5 text-[11px] leading-snug text-fg-fnt">
      {children}
    </p>
  );
}
