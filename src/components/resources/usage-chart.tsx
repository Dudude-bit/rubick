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
import {
  Area,
  AreaChart,
  ReferenceLine,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
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
  restartIndices,
  type UsagePoint,
  type UsageSample,
} from "@/lib/usage-history";
import { useT } from "@/i18n/useT";

/**
 * Tall enough to read a shape off. The 42px band this replaces turned every
 * series into a flat rule: at that height a doubling of load is four pixels.
 */
const BAND_H = 56;

/**
 * Room above the plot for the limit label — it sits above its own rule, and
 * the rule sits at the top of the scale whenever a limit exists — one pixel
 * below so the baseline hairline is a line rather than the bottom row of the
 * fill, and three at the right so the newest reading is a whole dot rather
 * than the half of one the frame did not cut off.
 */
const MARGIN = { top: 13, right: 3, bottom: 1, left: 0 };

/** Drawn at this width until the band has been measured — and in jsdom,
 *  where nothing is laid out, for the whole life of the test. */
const ASSUMED_W = 600;

/** What the wrapper wears; the series and its fill read it as currentColor. */
const LINE_ROLE = {
  ok: "text-info",
  warn: "text-warn",
  err: "text-err",
} as const;

/**
 * The highest reading in the window, or null where it holds none.
 *
 * What a stopped workload is summarised by. "What did it use when it ran" is
 * a question about the worst moment, not the last one — and the last one is
 * a value the reader would take for the current one.
 */
function peakOf(points: readonly UsagePoint[]): number | null {
  let peak: number | null = null;
  for (const point of points) {
    if (point.v !== null && (peak === null || point.v > peak)) peak = point.v;
  }
  return peak;
}

/** What a band says before it has two readings to join. */
export const WATCHING_NOTE =
  "Watching from now — metrics-server keeps no history, so the line starts here and grows to the right.";

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
  suppressNote = false,
  live = true,
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
          <Band
            points={points}
            drawn={drawn}
            max={max}
            limit={limit}
            type={type}
            label={label}
            limitNoun={limitNoun}
            live={live}
          />
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
        {suppressNote || (drawn === 0 && value === null)
          ? null
          : drawn <= 1 && live
            ? WATCHING_NOTE
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
  /** See {@link UsageChartProps.live}. */
  live: boolean;
}

interface Row {
  /** Bucket ordinal. The x scale counts buckets, not clocks: an empty bucket
   *  carries no timestamp, and plotting one would drag it to the far left. */
  i: number;
  t: number;
  v: number | null;
  restart: boolean;
}

function Band(props: BandProps) {
  const { points, drawn, max, limit, type, limitNoun } = props;
  const gradient = React.useId();
  const [band, width] = useBandWidth();
  const rows: Row[] = React.useMemo(
    () => points.map((point, i) => ({ i, ...point })),
    [points]
  );
  const restarts = React.useMemo(() => restartIndices(points), [points]);

  // A lone reading pins to the right edge: it is the newest one, and the
  // line grows leftward as more arrive.
  const domain: [number, number] =
    rows.length > 1 ? [0, rows.length - 1] : [-1, 0];

  // The line takes the tone the newest reading has earned. Below the warning
  // threshold it stays informational rather than green: a chart at 30% of
  // its limit is not an achievement worth colouring.
  const newest = latestValue(points);
  const tone =
    limit !== null && limit > 0 && newest !== null
      ? LINE_ROLE[usageRole(newest / limit)]
      : LINE_ROLE.ok;

  // The clock a tooltip counts back from is the newest reading's own
  // timestamp, not the wall clock: it is the last moment the cluster is
  // known to have answered, and reading it off the data keeps this pure.
  const now = points.length > 0 ? points[points.length - 1].t : 0;

  return (
    <div
      ref={band}
      // The chart is taken out of flow so its pixel width can never feed back
      // into the width being measured, which is the loop `ResponsiveContainer`
      // exists to break — and which it breaks by asking the DOM for a size
      // jsdom never gives it, leaving every test with an unrendered band.
      className={cn("relative w-full", tone)}
      style={{ height: BAND_H }}
      role="img"
      aria-label={describe(props)}
    >
      <div className="absolute inset-0">
        <AreaChart
          data={rows}
          width={width}
          height={BAND_H}
          margin={MARGIN}
          accessibilityLayer
        >
          <defs>
            {/* currentColor all the way down, so the fill is the same role
             *  token as the stroke and needs no resolved value from JS.
             *
             *  Anchored to the band rather than to the shape's own box: with
             *  the default the fade restarts under every line, and a series
             *  idling along the floor gets the same solid slab as one pinned
             *  against its limit. Here the ink is the height. */}
            <linearGradient
              id={gradient}
              gradientUnits="userSpaceOnUse"
              x1={0}
              y1={0}
              x2={0}
              y2={BAND_H}
            >
              <stop offset="0%" stopColor="currentColor" stopOpacity={0.3} />
              <stop offset="100%" stopColor="currentColor" stopOpacity={0.03} />
            </linearGradient>
          </defs>

          <XAxis hide type="number" dataKey="i" domain={domain} />
          <YAxis hide type="number" domain={[0, max]} />

          <ReferenceLine y={0} stroke="hsl(var(--hair))" strokeWidth={1} />

          {restarts.map((index) => (
            <ReferenceLine
              key={`restart-${index}`}
              x={index}
              stroke="hsl(var(--err))"
              strokeOpacity={0.6}
              strokeWidth={1}
            />
          ))}

          {limitInView(limit, max) && (
            <ReferenceLine
              y={limit!}
              stroke="hsl(var(--warn))"
              strokeOpacity={0.8}
              strokeWidth={1}
              strokeDasharray="3 3"
              label={<LimitLabel text={formatQuantity(limit!, type)} />}
            />
          )}

          <Area
            type="linear"
            dataKey="v"
            stroke="currentColor"
            strokeWidth={1.75}
            strokeLinejoin="round"
            strokeLinecap="round"
            fill={`url(#${gradient})`}
            // recharts dims an area to 0.6 by default; the stops carry the
            // whole fade, so anything else here is a second opacity.
            fillOpacity={1}
            // A straight segment across a bucket nothing was sampled in is a
            // claim that nothing happened there, and nobody knows that.
            connectNulls={false}
            // One reading is a point, not a line: a stroke joining nothing
            // would read as a flat trend nobody has measured yet.
            dot={
              drawn === 1
                ? { r: 2.5, fill: "currentColor", strokeWidth: 0 }
                : false
            }
            activeDot={{
              r: 3,
              fill: "currentColor",
              stroke: "hsl(var(--canvas))",
              strokeWidth: 2,
            }}
            // The poll is every few seconds and the reader may have asked for
            // less motion; a band that redraws itself on every tick is noise.
            isAnimationActive={false}
          />

          <Tooltip
            isAnimationActive={false}
            cursor={{
              stroke: "hsl(var(--fg-fnt))",
              strokeWidth: 1,
              strokeDasharray: "2 2",
            }}
            wrapperStyle={{ outline: "none", zIndex: 20 }}
            // A band is shorter than its own tooltip, so the tooltip goes
            // above the point rather than on top of the line it explains.
            allowEscapeViewBox={{ x: false, y: true }}
            reverseDirection={{ x: false, y: true }}
            offset={10}
            content={
              <UsageTooltip
                type={type}
                limit={limit}
                limitNoun={limitNoun}
                now={now}
              />
            }
          />
        </AreaChart>
      </div>
    </div>
  );
}

/** The band's own width in pixels, which is what recharts needs and CSS
 *  will not tell it. */
function useBandWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = React.useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = React.useState(ASSUMED_W);
  React.useEffect(() => {
    const node = ref.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const measured = Math.round(entries[0]?.contentRect.width ?? 0);
      if (measured > 0) setWidth(measured);
    });
    observer.observe(node);
    const initial = Math.round(node.getBoundingClientRect().width);
    if (initial > 0) setWidth(initial);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

/** The rule's own value, so "how close am I" is read rather than computed. */
function LimitLabel({
  text,
  viewBox,
}: {
  text: string;
  viewBox?: { x?: number; y?: number; width?: number; height?: number };
}) {
  if (!viewBox) return null;
  const x = (viewBox.x ?? 0) + (viewBox.width ?? 0) - 2;
  // Above its own rule, in the margin kept clear for it, rather than inside
  // the fill — where a workload sitting at its limit swallows it whole.
  const y = (viewBox.y ?? 0) - 4;
  return (
    <text
      x={x}
      y={y}
      textAnchor="end"
      className="fill-warn font-mono text-[9px] opacity-90"
    >
      limit {text}
    </text>
  );
}

interface TooltipPayload {
  payload: Row;
}

interface UsageTooltipProps {
  type: "cpu" | "memory";
  limit: number | null;
  limitNoun: string;
  now: number;
  /** Supplied by recharts. */
  active?: boolean;
  payload?: TooltipPayload[];
}

/** A chart you cannot read a number off is decoration. */
function UsageTooltip({
  type,
  limit,
  limitNoun,
  now,
  active,
  payload,
}: UsageTooltipProps) {
  const point = payload?.[0]?.payload;
  if (!active || !point || point.v === null) return null;
  const share =
    limit !== null && limit > 0 ? Math.round((point.v / limit) * 100) : null;
  return (
    <div
      className="pointer-events-none w-max rounded-md border border-hair bg-raise px-2 py-1.5 shadow-pop"
      role="status"
    >
      <div className="font-mono text-[10px] tabular-nums text-fg-fnt">
        {clockOf(point.t)} · {agoOf(point.t, now)}
      </div>
      <div className="mt-0.5 font-mono text-[11px] tabular-nums text-fg-mid">
        {formatQuantity(point.v, type)}
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
function describe({
  points,
  drawn,
  max,
  limit,
  type,
  label,
  limitNoun,
  live,
}: BandProps): string {
  if (drawn === 0) return `${label}: nothing recorded yet.`;
  const newest = live ? latestValue(points) : null;
  const parts = [
    `${label}: ${drawn} reading${drawn === 1 ? "" : "s"} ${live ? "watched" : "recorded, none since it stopped"}`,
    newest !== null ? `now ${formatQuantity(newest, type)}` : null,
    `peak ${formatQuantity(peakOf(points) ?? 0, type)}`,
    limit !== null && limit > 0
      ? `${limitNoun} ${formatQuantity(limit, type)}`
      : `no ${limitNoun} set, scaled to ${formatQuantity(max, type)} used`,
  ].filter(Boolean);
  const restarts = restartIndices(points).length;
  if (restarts > 0)
    parts.push(`${restarts} restart${restarts === 1 ? "" : "s"}`);
  return `${parts.join(", ")}.`;
}
