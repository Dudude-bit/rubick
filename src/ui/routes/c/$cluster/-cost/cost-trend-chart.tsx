/**
 * Cost per hour as one band, with the holes left open: a stretch Prometheus
 * holds no samples for is drawn as nothing, never as a line across it.
 * Loaded lazily, like the usage bands, so recharts stays out of first paint.
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

import type { DeclaredPoint } from "@/integrations";
import { useT } from "@/i18n/useT";
import { formatMoney } from "@/lib/cost";
import { clockOf } from "@/lib/usage-history";
import { BAND_H, BAND_MARGIN, useBandWidth } from "../-usage/band-frame";

const LINE = "hsl(var(--info))";
const HEADROOM = 1.15;

interface Row {
  i: number;
  t: number;
  v: number | null;
}

export default function CostTrendChart({
  points,
  currency,
}: {
  points: readonly DeclaredPoint[];
  currency: string;
}) {
  const t = useT();
  const rows: Row[] = React.useMemo(
    () => points.map((point, i) => ({ i, t: point.t, v: point.v })),
    [points]
  );
  const [band, width] = useBandWidth();
  const peak = rows.reduce((best, row) => Math.max(best, row.v ?? 0), 0);
  const domain: [number, number] =
    rows.length > 1 ? [0, rows.length - 1] : [-1, 0];
  const gaps = rows.filter((row) => row.v === null).length;
  return (
    <div
      ref={band}
      className="relative w-full"
      style={{ height: BAND_H }}
      role="img"
      aria-label={t("cost", "trendReadings", {
        n: rows.length - gaps,
        gaps,
        peak: formatMoney(peak, currency),
      })}
    >
      <div className="absolute inset-0">
        <AreaChart
          data={rows}
          width={width}
          height={BAND_H}
          margin={BAND_MARGIN}
          accessibilityLayer
        >
          <XAxis hide type="number" dataKey="i" domain={domain} />
          <YAxis
            hide
            type="number"
            domain={[0, peak > 0 ? peak * HEADROOM : 1]}
          />
          <ReferenceLine y={0} stroke="hsl(var(--hair))" strokeWidth={1} />
          <Area
            type="linear"
            dataKey="v"
            stroke={LINE}
            strokeWidth={1.75}
            fill={LINE}
            fillOpacity={0.1}
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
            content={<Tip currency={currency} />}
          />
        </AreaChart>
      </div>
    </div>
  );
}

function Tip({
  currency,
  active,
  payload,
}: {
  currency: string;
  active?: boolean;
  payload?: { payload: Row }[];
}) {
  const t = useT();
  const row = payload?.[0]?.payload;
  if (!active || !row) return null;
  return (
    <div
      className="pointer-events-none w-max rounded-md border border-hair bg-raise px-2 py-1.5 font-mono text-[11px] tabular-nums text-fg-mid shadow-pop"
      role="status"
    >
      {clockOf(row.t)} ·{" "}
      {row.v === null
        ? t("cost", "trendNoSample")
        : formatMoney(row.v, currency)}
    </div>
  );
}
