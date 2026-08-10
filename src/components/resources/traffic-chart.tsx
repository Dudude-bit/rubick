/**
 * Bytes in and out, on one band.
 *
 * The rule that keeps CPU and memory apart — two measures on two scales need
 * two plots, because the crossing point of their lines would mean nothing —
 * does not apply here. In and out are the same measure in two directions on
 * one scale, so their crossing point is a real event: the moment a workload
 * stopped mostly receiving and started mostly sending. That is worth being
 * able to see, so they share a band.
 *
 * Identity is never colour alone: each line's own value is printed beside
 * its name underneath, so the band is readable with the hues indistinguishable.
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

import { formatQuantity } from "@/lib/metric-format";
import { agoOf, clockOf } from "@/lib/usage-history";
import type { TrafficWindow } from "@/integrations";

const BAND_H = 56;
const MARGIN = { top: 13, right: 3, bottom: 1, left: 0 };
const ASSUMED_W = 600;

/** Room above the peak, so a maximum is not a stroke sliced by the frame. */
const HEADROOM = 1.25;

/**
 * One role token and one neutral, told apart by dash rather than by hue.
 *
 * A second saturated colour would need its own contrast and colour-blindness
 * check before it could be trusted at 2px, which is exactly the check that
 * kept the per-container palette out of this block. A solid informational
 * line and a dashed muted one need no such check: the dash carries the
 * distinction, the hue only reinforces it, and both values are printed.
 */
const IN_ROLE = "hsl(var(--info))";
const OUT_ROLE = "hsl(var(--fg-mut))";

interface Row {
  i: number;
  t: number;
  rx: number | null;
  tx: number | null;
}

export interface TrafficChartProps {
  window: TrafficWindow;
  /** Where the numbers came from, for the row that has no fallback to name. */
  label?: string;
}

/**
 * The band, or nothing.
 *
 * A window with no points draws no row at all rather than an empty plot:
 * there is no core answer for traffic, so "the app has nothing to say here"
 * has to look like silence and not like zero bytes.
 */
export function TrafficChart({
  window: data,
  label = "Network",
}: TrafficChartProps) {
  const rows: Row[] = React.useMemo(
    () => data.points.map((point, i) => ({ i, ...point })),
    [data.points]
  );
  const [band, width] = useBandWidth();

  const drawn = rows.filter((row) => row.rx !== null || row.tx !== null).length;
  if (drawn === 0) return null;

  const peak = rows.reduce(
    (best, row) => Math.max(best, row.rx ?? 0, row.tx ?? 0),
    0
  );
  const max = peak > 0 ? peak * HEADROOM : 1;
  const newest = rows[rows.length - 1];
  const domain: [number, number] =
    rows.length > 1 ? [0, rows.length - 1] : [-1, 0];
  const now = newest?.t ?? 0;

  return (
    <div>
      <div className="grid grid-cols-[92px_minmax(0,1fr)_150px] items-center gap-3 px-1.5 py-2">
        <span className="text-[11px] text-fg-mut">{label}</span>
        <div
          ref={band}
          className="relative w-full"
          style={{ height: BAND_H }}
          role="img"
          aria-label={describe(rows, peak)}
        >
          <div className="absolute inset-0">
            <AreaChart
              data={rows}
              width={width}
              height={BAND_H}
              margin={MARGIN}
              accessibilityLayer
            >
              <XAxis hide type="number" dataKey="i" domain={domain} />
              <YAxis hide type="number" domain={[0, max]} />
              <ReferenceLine y={0} stroke="hsl(var(--hair))" strokeWidth={1} />
              <Area
                type="linear"
                dataKey="rx"
                stroke={IN_ROLE}
                strokeWidth={1.75}
                fill={IN_ROLE}
                fillOpacity={0.1}
                connectNulls={false}
                dot={false}
                isAnimationActive={false}
              />
              <Area
                type="linear"
                dataKey="tx"
                stroke={OUT_ROLE}
                strokeWidth={1.75}
                strokeDasharray="3 2"
                fill="none"
                connectNulls={false}
                dot={false}
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
                allowEscapeViewBox={{ x: false, y: true }}
                reverseDirection={{ x: false, y: true }}
                offset={10}
                content={<TrafficTooltip now={now} />}
              />
            </AreaChart>
          </div>
        </div>
        <span className="text-right text-[11px] text-fg-mut">
          <span className="font-mono tabular-nums">
            {formatQuantity(newest?.rx ?? 0, "throughput")}
          </span>
        </span>
      </div>
      {/* Identity is never colour alone: the name and the number carry it,
       *  and the swatch only confirms which line is which. */}
      <div className="flex gap-4 pb-1 pl-[104px] pr-1.5 text-[11px] text-fg-fnt">
        <Key colour={IN_ROLE} name="in" value={newest?.rx ?? null} />
        <Key colour={OUT_ROLE} name="out" value={newest?.tx ?? null} dashed />
      </div>
    </div>
  );
}

function Key({
  colour,
  name,
  value,
  dashed = false,
}: {
  colour: string;
  name: string;
  value: number | null;
  dashed?: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        aria-hidden
        className="inline-block h-0 w-2.5"
        style={{
          borderTop: `2px ${dashed ? "dashed" : "solid"} ${colour}`,
        }}
      />
      {name}{" "}
      <span className="font-mono tabular-nums text-fg-mut">
        {value === null ? "—" : formatQuantity(value, "throughput")}
      </span>
    </span>
  );
}

interface TooltipPayload {
  payload: Row;
}

function TrafficTooltip({
  now,
  active,
  payload,
}: {
  now: number;
  active?: boolean;
  payload?: TooltipPayload[];
}) {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;
  return (
    <div
      className="pointer-events-none w-max rounded-md border border-hair bg-raise px-2 py-1.5 shadow-pop"
      role="status"
    >
      <div className="font-mono text-[10px] tabular-nums text-fg-fnt">
        {clockOf(point.t)} · {agoOf(point.t, now)}
      </div>
      <div className="mt-0.5 font-mono text-[11px] tabular-nums text-fg-mid">
        in {point.rx === null ? "—" : formatQuantity(point.rx, "throughput")} ·
        out {point.tx === null ? "—" : formatQuantity(point.tx, "throughput")}
      </div>
    </div>
  );
}

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

function describe(rows: readonly Row[], peak: number): string {
  const newest = rows[rows.length - 1];
  return [
    `Network: ${rows.length} readings`,
    `now in ${formatQuantity(newest?.rx ?? 0, "throughput")}`,
    `out ${formatQuantity(newest?.tx ?? 0, "throughput")}`,
    `peak ${formatQuantity(peak, "throughput")}`,
  ].join(", ");
}
