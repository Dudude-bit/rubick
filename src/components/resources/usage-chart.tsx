/**
 * One measure, over the window this app has watched.
 *
 * Drawn by hand rather than with `recharts`: the whole mark is a 42px band
 * holding one path, one dashed rule and a crosshair, and a charting library
 * would bring a responsive container, a cartesian grid and a legend engine
 * to render a `<path>` this file computes in `usage-history.ts` anyway.
 * Hand-drawn is also the only way the marks wear role tokens — the palette
 * has to resolve per theme from `index.css`, and a library that takes
 * colours as props would have to be fed resolved values from JS.
 *
 * CPU and memory stay two bands. One plot with two y-axes would put the
 * crossing point of the lines on screen, and that point means nothing.
 */
import * as React from "react";
import { cn } from "@/lib/utils";
import { UnitValue } from "@/components/ui/metric-value";
import { formatQuantity, usageRole } from "@/lib/metric-format";
import {
  agoOf,
  bucketize,
  chartMax,
  clockOf,
  latestValue,
  limitInView,
  linePath,
  restartIndices,
  xOf,
  yOf,
  type Geometry,
  type UsagePoint,
  type UsageSample,
} from "@/lib/usage-history";

/** The virtual width every path is computed in; the SVG scales it to fit. */
const VIEW_W = 600;
const BAND_H = 42;
const GEOMETRY: Geometry = { width: VIEW_W, height: BAND_H, topPad: 4 };

const LINE_ROLE = {
  ok: "text-info",
  warn: "text-warn",
  err: "text-err",
} as const;

/** What a band says when nothing declares a ceiling for it. */
export const NO_LIMIT_NOTE =
  "No limit set — the scale is what it has used, and nothing stops it taking the node's.";

export interface UsageChartProps {
  label: string;
  type: "cpu" | "memory";
  samples: readonly UsageSample[];
  /** The declared ceiling, or null when the object has none. */
  limit: number | null;
  /** What the ceiling is called here — a pod has limits, a node a capacity. */
  limitNoun?: string;
  /**
   * Sentence for the no-limit case. Defaulted here rather than only at the
   * call site: a band that silently omitted it would be the very bug this
   * replaces — a scale with no stated denominator.
   */
  noLimitNote?: string | null;
  /** Live value, used before the buffer has anything to draw. */
  current: number | null;
}

/**
 * A band, plus whichever sentence the data has earned: none when there is
 * a limit and a line, one when either is missing.
 */
export function UsageChart({
  label,
  type,
  samples,
  limit,
  limitNoun = "limit",
  noLimitNote = NO_LIMIT_NOTE,
  current,
}: UsageChartProps) {
  const channel = type === "cpu" ? "cpuMillicores" : "memoryBytes";
  const points = React.useMemo(
    () => bucketize(samples, channel),
    [samples, channel]
  );

  const drawn = points.filter((point) => point.v !== null).length;
  const max = chartMax(points, limit);
  const value = latestValue(points) ?? current;
  const ratio =
    limit !== null && limit > 0 && value !== null ? value / limit : null;

  return (
    <div>
      <div className="grid grid-cols-[92px_minmax(0,1fr)_150px] items-center gap-3 px-1.5 py-1">
        <span className="text-[11px] text-fg-mut">{label}</span>
        {/* No reading at all draws no band. A 42px box with nothing in it
         *  is the empty plot this replaced, one size larger. */}
        {value === null && drawn === 0 ? (
          <span />
        ) : (
          <Band
            points={points}
            drawn={drawn}
            max={max}
            limit={limit}
            type={type}
            label={label}
            limitNoun={limitNoun}
          />
        )}
        <span className="text-right text-[11px] text-fg-mut">
          {value === null ? (
            // The block only draws bands while metrics-server is available,
            // so a missing value here is the server having nothing to say
            // about this object — usually a container that is not running.
            <span
              className="text-fg-fnt"
              title="metrics-server has no reading for this object — its containers may not be running"
            >
              not reporting
            </span>
          ) : (
            <>
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
      <Note>
        {drawn === 0 && value === null
          ? null
          : drawn <= 1
            ? "Watching from now — metrics-server keeps no history, so the line starts here and grows to the right."
            : limit === null || limit <= 0
              ? noLimitNote
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

interface BandProps {
  points: UsagePoint[];
  drawn: number;
  max: number;
  limit: number | null;
  type: "cpu" | "memory";
  label: string;
  limitNoun: string;
}

function Band({
  points,
  drawn,
  max,
  limit,
  type,
  label,
  limitNoun,
}: BandProps) {
  const [hover, setHover] = React.useState<number | null>(null);
  // The clock the tooltip counts back from is the newest reading's own
  // timestamp, not the wall clock: it is the last moment the cluster is
  // known to have answered, and reading it off the data keeps this pure.
  const now = points.length > 0 ? points[points.length - 1].t : 0;

  const line = React.useMemo(
    () => linePath(points, max, GEOMETRY),
    [points, max]
  );
  const restarts = React.useMemo(() => restartIndices(points), [points]);

  const limitY = limitInView(limit, max) ? yOf(limit!, max, GEOMETRY) : null;

  // The line takes the tone the newest reading has earned. Below the warning
  // threshold it stays informational rather than green: a chart at 30% of
  // its limit is not an achievement worth colouring.
  const newest = latestValue(points);
  const tone =
    limit !== null && limit > 0 && newest !== null
      ? LINE_ROLE[usageRole(newest / limit)]
      : LINE_ROLE.ok;

  const hovered = hover !== null ? points[hover] : undefined;

  const move = (event: React.PointerEvent<SVGSVGElement>) => {
    if (points.length === 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width === 0) return;
    const fraction = (event.clientX - rect.left) / rect.width;
    const index = Math.round(fraction * (points.length - 1));
    setHover(Math.min(points.length - 1, Math.max(0, index)));
  };

  const key = (event: React.KeyboardEvent<SVGSVGElement>) => {
    if (points.length === 0) return;
    const at = hover ?? points.length - 1;
    const to =
      event.key === "ArrowLeft"
        ? at - 1
        : event.key === "ArrowRight"
          ? at + 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? points.length - 1
              : null;
    if (to === null) return;
    event.preventDefault();
    setHover(Math.min(points.length - 1, Math.max(0, to)));
  };

  const summary = describe(points, drawn, max, limit, type, label, limitNoun);

  return (
    <div className="relative">
      <svg
        width="100%"
        height={BAND_H}
        viewBox={`0 0 ${VIEW_W} ${BAND_H}`}
        preserveAspectRatio="none"
        className={cn("block touch-none", tone)}
        role="img"
        aria-label={summary}
        tabIndex={0}
        onPointerMove={move}
        onPointerLeave={() => setHover(null)}
        onBlur={() => setHover(null)}
        onKeyDown={key}
      >
        <line
          x1="0"
          y1={BAND_H - 0.5}
          x2={VIEW_W}
          y2={BAND_H - 0.5}
          className="stroke-hair"
          strokeWidth="1"
          vectorEffect="non-scaling-stroke"
        />

        {limitY !== null && (
          <line
            x1="0"
            y1={limitY}
            x2={VIEW_W}
            y2={limitY}
            className="stroke-warn opacity-80"
            strokeWidth="1"
            strokeDasharray="3 3"
            vectorEffect="non-scaling-stroke"
          />
        )}

        {restarts.map((index) => (
          <line
            key={`restart-${index}`}
            x1={xOf(index, points.length, VIEW_W)}
            y1="0"
            x2={xOf(index, points.length, VIEW_W)}
            y2={BAND_H}
            className="stroke-err opacity-60"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
        ))}

        {line && (
          <path
            d={line}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        )}

        {/* One reading is a point, not a line: two pixels of stroke joining
         *  nothing would read as a flat trend nobody has measured yet. */}
        {drawn === 1 &&
          points.map((point, index) =>
            point.v === null ? null : (
              <circle
                key="seed"
                cx={xOf(index, points.length, VIEW_W)}
                cy={yOf(point.v, max, GEOMETRY)}
                r="2.5"
                fill="currentColor"
                vectorEffect="non-scaling-stroke"
              />
            )
          )}

        {hovered?.v != null && (
          <>
            <line
              x1={xOf(hover!, points.length, VIEW_W)}
              y1="0"
              x2={xOf(hover!, points.length, VIEW_W)}
              y2={BAND_H}
              className="stroke-fg-fnt"
              strokeWidth="1"
              strokeDasharray="2 2"
              vectorEffect="non-scaling-stroke"
            />
            <circle
              cx={xOf(hover!, points.length, VIEW_W)}
              cy={yOf(hovered.v, max, GEOMETRY)}
              r="3"
              fill="currentColor"
              className="stroke-canvas"
              strokeWidth="2"
              vectorEffect="non-scaling-stroke"
            />
          </>
        )}
      </svg>

      {hovered?.v != null && (
        <Tooltip
          fraction={points.length <= 1 ? 1 : hover! / (points.length - 1)}
          point={hovered}
          value={hovered.v}
          type={type}
          limit={limit}
          limitNoun={limitNoun}
          now={now}
        />
      )}
    </div>
  );
}

interface TooltipProps {
  fraction: number;
  point: UsagePoint;
  value: number;
  type: "cpu" | "memory";
  limit: number | null;
  limitNoun: string;
  now: number;
}

/** A chart you cannot read a number off is decoration. */
function Tooltip({
  fraction,
  point,
  value,
  type,
  limit,
  limitNoun,
  now,
}: TooltipProps) {
  const share =
    limit !== null && limit > 0 ? Math.round((value / limit) * 100) : null;
  return (
    <div
      className="pointer-events-none absolute bottom-full z-20 mb-1 w-max -translate-x-1/2 rounded-md border border-hair bg-raise px-2 py-1.5 shadow-pop"
      style={{
        left: `${Math.min(88, Math.max(12, fraction * 100))}%`,
      }}
      role="status"
    >
      <div className="font-mono text-[10px] tabular-nums text-fg-fnt">
        {clockOf(point.t)} · {agoOf(point.t, now)}
      </div>
      <div className="mt-0.5 font-mono text-[11px] tabular-nums text-fg-mid">
        {formatQuantity(value, type)}
        {share !== null && (
          <span className="text-fg-fnt">
            {" "}
            · {share}% of {limitNoun}
          </span>
        )}
        {point.restart && <span className="text-err"> · restarted</span>}
      </div>
    </div>
  );
}

/**
 * What a screen reader is told, and what a hover would otherwise be the
 * only way to learn: the peak matters more than the current value here,
 * because the peak is what the buckets were kept for.
 */
function describe(
  points: readonly UsagePoint[],
  drawn: number,
  max: number,
  limit: number | null,
  type: "cpu" | "memory",
  label: string,
  limitNoun: string
): string {
  if (drawn === 0) return `${label}: nothing recorded yet.`;
  const newest = latestValue(points);
  const peak = points.reduce(
    (best, point) => (point.v !== null && point.v > best ? point.v : best),
    0
  );
  const parts = [
    `${label}: ${drawn} reading${drawn === 1 ? "" : "s"} watched`,
    newest !== null ? `now ${formatQuantity(newest, type)}` : null,
    `peak ${formatQuantity(peak, type)}`,
    limit !== null && limit > 0
      ? `${limitNoun} ${formatQuantity(limit, type)}`
      : `no ${limitNoun} set, scaled to ${formatQuantity(max, type)} used`,
  ].filter(Boolean);
  const restarts = restartIndices(points).length;
  if (restarts > 0)
    parts.push(`${restarts} restart${restarts === 1 ? "" : "s"}`);
  return `${parts.join(", ")}.`;
}
