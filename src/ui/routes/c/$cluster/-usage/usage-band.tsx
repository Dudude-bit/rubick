/**
 * The plot itself, loaded when the first one is drawn: recharts is most of
 * what a detail page would otherwise download before it can show anything.
 */

import * as React from "react";
import {
  Area,
  AreaChart,
  Line,
  ReferenceArea,
  ReferenceLine,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { DeclaredPoint } from "@/integrations";
import { cn, formatSince } from "@/lib/utils";
import { formatQuantity, usageRole } from "@/lib/metric-format";
import {
  clockOf,
  latestValue,
  limitInView,
  peakOf,
  restartIndices,
  type UsagePoint,
} from "@/lib/usage-history";
import { useT, type T } from "@/i18n/useT";
import { BAND_H, BAND_MARGIN, useBandWidth } from "./band-frame";

/** What the wrapper wears; the series and its fill read it as currentColor. */
const LINE_ROLE = {
  ok: "text-info",
  warn: "text-warn",
  err: "text-err",
} as const;

/** The declared value in force at each bucket: the last one written at or before it. */
function stepAlong(
  points: readonly UsagePoint[],
  declared: readonly DeclaredPoint[]
): Array<number | null> {
  let cursor = 0;
  let current: number | null = null;
  return points.map((point) => {
    while (cursor < declared.length && declared[cursor].t <= point.t) {
      current = declared[cursor].v;
      cursor += 1;
    }
    return current;
  });
}

export interface BandProps {
  points: UsagePoint[];
  drawn: number;
  max: number;
  limit: number | null;
  request: number | null;
  declared?: {
    request: readonly DeclaredPoint[];
    limit: readonly DeclaredPoint[];
  } | null;
  type: "cpu" | "memory";
  label: string;
  limitNoun: "limitWord" | "capacityWord";
  /** See {@link UsageChartProps.live}. */
  live: boolean;
}

interface Row {
  /** Bucket ordinal. The x scale counts buckets, not clocks: an empty bucket
   *  carries no timestamp, and plotting one would drag it to the far left. */
  i: number;
  t: number;
  v: number | null;
  /** Always 0: gives a hover over a gap something to report, since recharts shows no tooltip for an empty payload. */
  hit: number;
  restart: boolean;
  /** Where `v` is null: the readings either side of the hole, `null` where there is none. */
  gap?: { from: number | null; to: number | null };
  /** What was asked for and allowed at this bucket, where a supplier kept it. */
  request?: number | null;
  ceiling?: number | null;
}

/** The runs of buckets nothing was sampled in, with the rows either side of each. */
function gapsOf(points: readonly UsagePoint[]): Array<{
  start: number;
  end: number;
  before: number | null;
  after: number | null;
}> {
  const out: ReturnType<typeof gapsOf> = [];
  let i = 0;
  while (i < points.length) {
    if (points[i].v !== null) {
      i += 1;
      continue;
    }
    const start = i;
    while (i < points.length && points[i].v === null) i += 1;
    out.push({
      start,
      end: i - 1,
      before: start > 0 ? start - 1 : null,
      after: i < points.length ? i : null,
    });
  }
  return out;
}

export default function Band(props: BandProps) {
  const t = useT();
  const { points, drawn, max, limit, request, declared, type, limitNoun } =
    props;
  const gradient = React.useId();
  const [band, width] = useBandWidth();
  const rows: Row[] = React.useMemo(() => {
    const base: Row[] = points.map((point, i) => ({ i, hit: 0, ...point }));
    for (const gap of gapsOf(points)) {
      const from = gap.before === null ? null : points[gap.before].t;
      const to = gap.after === null ? null : points[gap.after].t;
      for (let at = gap.start; at <= gap.end; at += 1)
        base[at].gap = { from, to };
    }
    if (!declared) return base;
    const requests = stepAlong(points, declared.request);
    const ceilings = stepAlong(points, declared.limit);
    return base.map((row, i) => ({
      ...row,
      request: requests[i],
      ceiling: ceilings[i],
    }));
  }, [points, declared]);
  // A recorded line replaces the flat one; a flat one is today's figure and
  // is labelled as such where the record is known to be missing.
  //
  // On whether the record has values, not on whether the object exists: a
  // declared history that came back empty — or whose range query was
  // swallowed to `[]` — is an object, and `!!declared` then switched off
  // both the flat fallback and the label, erasing the request and limit
  // rules from the chart entirely rather than drawing today's figure.
  const recorded = React.useMemo(
    () =>
      declared !== null &&
      declared !== undefined &&
      rows.some((row) => row.request !== null || row.ceiling !== null),
    [declared, rows]
  );
  const flatLabel =
    declared === null ? ` ${t("readings", "usageNowWord")}` : "";
  const restarts = React.useMemo(() => restartIndices(points), [points]);
  const gaps = React.useMemo(() => gapsOf(points), [points]);

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
      aria-label={describe(props, t)}
    >
      <div className="absolute inset-0">
        <AreaChart
          data={rows}
          width={width}
          height={BAND_H}
          margin={BAND_MARGIN}
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

          {gaps.map((gap) => (
            <ReferenceArea
              key={`gap-${gap.start}`}
              data-gap=""
              x1={gap.before ?? gap.start}
              x2={gap.after ?? gap.end}
              fill="currentColor"
              fillOpacity={0.06}
              stroke="currentColor"
              strokeOpacity={0.3}
              strokeDasharray="2 2"
              ifOverflow="hidden"
              label={{
                value: t("readings", "usageGapCaption"),
                position: "insideTopLeft",
                fill: "hsl(var(--fg-fnt))",
                fontSize: 10,
              }}
            />
          ))}

          {restarts.map((index) => (
            <ReferenceLine
              key={`restart-${index}`}
              x={index}
              stroke="hsl(var(--err))"
              strokeOpacity={0.6}
              strokeWidth={1}
            />
          ))}

          {!recorded && limitInView(limit, max) && (
            <ReferenceLine
              y={limit!}
              stroke="hsl(var(--fg-mut))"
              strokeOpacity={0.8}
              strokeWidth={1}
              strokeDasharray="3 3"
              label={
                <LimitLabel
                  word={t("readings", limitNoun)}
                  text={`${formatQuantity(limit!, type)}${flatLabel}`}
                />
              }
            />
          )}
          {!recorded && request !== null && request > 0 && request <= max && (
            <ReferenceLine
              y={request}
              stroke="hsl(var(--fg-fnt))"
              strokeOpacity={0.9}
              strokeWidth={1}
              strokeDasharray="1 3"
              label={
                <LimitLabel
                  word={t("readings", "requestWord")}
                  text={`${formatQuantity(request, type)}${flatLabel}`}
                />
              }
            />
          )}
          {recorded && (
            <>
              <Line
                type="stepAfter"
                dataKey="ceiling"
                stroke="hsl(var(--fg-mut))"
                strokeOpacity={0.8}
                strokeWidth={1}
                strokeDasharray="3 3"
                dot={false}
                activeDot={false}
                connectNulls={false}
                isAnimationActive={false}
              />
              <Line
                type="stepAfter"
                dataKey="request"
                stroke="hsl(var(--fg-fnt))"
                strokeOpacity={0.9}
                strokeWidth={1}
                strokeDasharray="1 3"
                dot={false}
                activeDot={false}
                connectNulls={false}
                isAnimationActive={false}
              />
            </>
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
            dot={(dot: {
              cx?: number;
              cy?: number;
              index?: number;
              payload?: Row;
            }) => {
              const at = dot.index ?? -1;
              const alone =
                drawn === 1 ||
                (points[at]?.v != null &&
                  (at === 0 || points[at - 1].v === null) &&
                  (at === points.length - 1 || points[at + 1].v === null));
              return alone && dot.cx !== undefined && dot.cy !== undefined ? (
                <circle
                  className="recharts-dot"
                  key={`dot-${at}`}
                  cx={dot.cx}
                  cy={dot.cy}
                  r={2.5}
                  fill="currentColor"
                />
              ) : (
                <g key={`dot-${at}`} />
              );
            }}
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

          <Line
            dataKey="hit"
            stroke="none"
            dot={false}
            activeDot={false}
            isAnimationActive={false}
            legendType="none"
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
                rows={rows}
              />
            }
          />
        </AreaChart>
      </div>
    </div>
  );
}

/** The rule's own value, so "how close am I" is read rather than computed. */
function LimitLabel({
  text,
  word,
  viewBox,
}: {
  text: string;
  word: string;
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
      className="fill-fg-mut font-mono text-micro opacity-90"
    >
      {word} {text}
    </text>
  );
}

interface TooltipPayload {
  payload: Row;
}

interface UsageTooltipProps {
  type: "cpu" | "memory";
  limit: number | null;
  limitNoun: "limitWord" | "capacityWord";
  now: number;
  rows: readonly Row[];
  /** Supplied by recharts. */
  active?: boolean;
  payload?: TooltipPayload[];
  label?: number | string;
}

/** A chart you cannot read a number off is decoration. */
function UsageTooltip({
  type,
  limit,
  limitNoun,
  now,
  rows,
  active,
  payload,
  label,
}: UsageTooltipProps) {
  const t = useT();
  const point =
    payload?.[0]?.payload ??
    (typeof label === "number" ? rows[label] : undefined);
  if (!active || !point) return null;
  if (point.v === null) {
    if (!point.gap) return null;
    const { from, to } = point.gap;
    return (
      <div
        className="pointer-events-none w-max rounded-md border border-hair bg-raise px-2 py-1.5 shadow-pop"
        role="status"
        data-gap-note=""
      >
        <div className="font-mono text-micro tabular-nums text-fg-mid">
          {from !== null && to !== null
            ? t("readings", "usageNoSample", {
                from: clockOf(from),
                to: clockOf(to),
              })
            : from !== null
              ? t("readings", "usageNoSampleSince", { from: clockOf(from) })
              : to !== null
                ? t("readings", "usageNoSampleBefore", { to: clockOf(to) })
                : t("readings", "usageNoSampleHere")}
        </div>
      </div>
    );
  }
  const share =
    limit !== null && limit > 0 ? Math.round((point.v / limit) * 100) : null;
  return (
    <div
      className="pointer-events-none w-max rounded-md border border-hair bg-raise px-2 py-1.5 shadow-pop"
      role="status"
    >
      <div className="font-mono text-micro tabular-nums text-fg-fnt">
        {clockOf(point.t)} ·{" "}
        {t("action", "agoSuffix", { age: formatSince(point.t, now) })}
      </div>
      <div className="mt-0.5 font-mono text-caption tabular-nums text-fg-mid">
        {formatQuantity(point.v, type)}
        {share !== null && (
          <span className="text-fg-fnt">
            {" "}
            {" · "}
            {t("readings", "usageShareOf", {
              percent: share,
              noun: t("readings", limitNoun),
            })}
          </span>
        )}
        {point.restart && (
          <span className="text-err"> · {t("readings", "usageRestarted")}</span>
        )}
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
  { points, drawn, max, limit, type, label, limitNoun, live }: BandProps,
  t: T
): string {
  if (drawn === 0) return t("readings", "usageNothingYet", { label });
  const newest = live ? latestValue(points) : null;
  const noun = t("readings", limitNoun);
  const parts = [
    live
      ? t("readings", "usageReadingsWatched", { label, n: drawn })
      : t("readings", "usageReadingsRecorded", { label, n: drawn }),
    newest !== null
      ? t("readings", "usageNow", { value: formatQuantity(newest, type) })
      : null,
    t("readings", "usagePeak", {
      value: formatQuantity(peakOf(points) ?? 0, type),
    }),
    limit !== null && limit > 0
      ? t("readings", "usageLimitIs", {
          noun,
          value: formatQuantity(limit, type),
        })
      : t("readings", "usageNoLimit", {
          noun,
          value: formatQuantity(max, type),
        }),
  ].filter(Boolean);
  const restarts = restartIndices(points).length;
  if (restarts > 0) parts.push(t("readings", "usageRestarts", { n: restarts }));
  return `${parts.join(", ")}.`;
}
