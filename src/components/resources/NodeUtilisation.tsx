import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useCapabilityState, USAGE_RANGES } from "@/integrations";
import type { DeclaredPoint, UsageRange } from "@/integrations";
import { normalizeTauriError } from "@/lib/error-utils";
import { getResourceDetailUrl } from "@/lib/navigation-utils";
import {
  nodeTrends,
  type NodeTrend,
  type TrendBlind,
  type TrendLane,
} from "@/lib/node-trends";
import { nodePlacement } from "@/lib/node-pool";
import { ResourceType } from "@/lib/resource-registry";
import { agoOf } from "@/lib/usage-history";
import { cn } from "@/lib/utils";
import type { NodeInfo } from "@/generated/types";
import { useT } from "@/i18n/useT";
import type { en } from "@/i18n/catalogue";

/** The ranges worth a sparkline: a quarter hour is what the table already shows. */
const TREND_RANGES = USAGE_RANGES.filter((range) => range !== "15m");

interface NodeUtilisationProps {
  nodes: readonly NodeInfo[];
  /**
   * Whether `nodes` is an answer. The table view surfaces a refused node list
   * through ResourceList; this view replaces ResourceList, so without this the
   * failure had no reader and rendered as "this cluster has no nodes".
   */
  nodesKnown?: boolean;
  /** Why the node list could not be read, where that is known. */
  nodesReason?: string | null;
  range: UsageRange;
  onRange: (range: UsageRange) => void;
}

/**
 * Every node over a window, least headroom first.
 *
 * One range query per measure for the whole cluster, so the view costs the
 * same on five nodes and on five hundred. A high number is a full node, not
 * an incident: nothing here is painted red for being busy.
 */
export function NodeUtilisation({
  nodes,
  nodesKnown = true,
  nodesReason = null,
  range,
  onRange,
}: NodeUtilisationProps) {
  const t = useT();
  const power = useCapabilityState("usage.nodes");
  const ready = power.state === "ready";

  const query = useQuery({
    queryKey: ["usage-nodes", range],
    queryFn: () =>
      (power as Extract<typeof power, { state: "ready" }>).use({ range }),
    enabled: ready,
    staleTime: 30_000,
    retry: false,
  });

  // The moment the answer landed is the clock every "ago" is read against:
  // a wall clock read in render would move on every re-render.
  const now = query.dataUpdatedAt;
  // An answer, not merely an absence of one: in flight, refused, or a
  // supplier that is not ready all mean we could not look, and the rows must
  // not turn that into "Prometheus has no series for this node".
  const windowKnown = ready && !query.isPending && query.error === null;
  const trends = useMemo(
    () => nodeTrends(query.data ?? null, nodes, now, windowKnown),
    [query.data, nodes, now, windowKnown]
  );

  // Before anything about Prometheus: with no node list there is nothing to
  // put a lane against, and an empty table here reads as "this cluster has
  // no nodes" — which is the node list's failure wearing the cluster's face.
  if (!nodesKnown) {
    return (
      <p className="px-1 py-6 text-xs text-warn" role="status">
        {nodesReason
          ? t("empty", "nodesDidNotList", { reason: nodesReason })
          : t("action", "reading")}
      </p>
    );
  }

  if (power.state === "absent") {
    return (
      <p className="px-1 py-6 text-xs text-fg-mut">
        {t("empty", "trendsNeedPrometheus")}{" "}
        <Link to="/integrations" className="text-info hover:underline">
          {t("action", "connectOne")}
        </Link>
        .
      </p>
    );
  }

  return (
    <div>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-1 pb-2 text-[11px] text-fg-fnt">
        <span>{t("empty", "trendsSortNote")}</span>
        {power.state === "ready" && (
          <span>
            {t("count", "fromEndpoint", { endpoint: power.endpoint })}
            {query.data ? ` · ${query.data.resolution}` : ""}
          </span>
        )}
        <span className="ml-auto flex items-center gap-0.5">
          {query.isFetching && (
            <span className="mr-1 text-[10px]">
              {t("action", "readingInline")}
            </span>
          )}
          {TREND_RANGES.map((candidate) => (
            <button
              key={candidate}
              type="button"
              aria-pressed={candidate === range}
              onClick={() => onRange(candidate)}
              className={
                candidate === range
                  ? "rounded bg-sel px-1.5 py-0.5 text-[11px] text-fg"
                  : "rounded px-1.5 py-0.5 text-[11px] text-fg-mut hover:bg-hover hover:text-fg"
              }
            >
              {candidate}
            </button>
          ))}
        </span>
      </div>
      {power.state === "unreachable" && (
        <p className="px-1 pb-2 text-[11px] text-warn" role="status">
          {t("empty", "vendorDidNotAnswer", {
            vendor: power.vendor,
            reason: power.reason,
          })}
        </p>
      )}
      {query.error && (
        <p className="px-1 pb-2 text-[11px] text-warn" role="status">
          {t("empty", "vendorDidNotAnswer", {
            vendor: power.state === "ready" ? power.vendor : "",
            reason: normalizeTauriError(query.error),
          })}
        </p>
      )}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("columns", "node")}</TableHead>
            <TableHead>{t("columns", "cpuOfAllocatable")}</TableHead>
            <TableHead>{t("columns", "memoryOfAllocatable")}</TableHead>
            <TableHead>{t("columns", "note")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {trends.map((trend) => (
            <Row key={trend.node.name} trend={trend} range={range} now={now} />
          ))}
        </TableBody>
      </Table>
      <p className="px-1 pt-2 text-[11px] text-fg-fnt">
        {t("empty", "trendsNotIncidents")}
      </p>
    </div>
  );
}

function Row({
  trend,
  range,
  now,
}: {
  trend: NodeTrend;
  range: UsageRange;
  now: number;
}) {
  const t = useT();
  const placement = nodePlacement(trend.node);
  const facts = [
    placement.pool,
    placement.machine,
    placement.spot ? "spot" : null,
  ]
    .filter((f): f is string => !!f)
    .join(" · ");
  const silent = trend.cpu === null && trend.memory === null;
  return (
    <TableRow data-quiet>
      <TableCell>
        <Link
          to={getResourceDetailUrl(ResourceType.Node, trend.node.name)}
          className="font-mono text-xs text-fg hover:underline"
        >
          {trend.node.name}
        </Link>
        {facts && (
          <span className="ml-2 text-[11px] text-fg-fnt">
            {facts}
            {trend.cordoned ? ` · ${t("readings", "cordonedWord")}` : ""}
          </span>
        )}
      </TableCell>
      <Lane lane={trend.cpu} blind={trend.blind} />
      <Lane lane={trend.memory} blind={trend.blind} />
      <TableCell className="text-[11px] text-fg-fnt">
        {silent
          ? trend.blind === "notLooked"
            ? t("empty", "nodeNotLooked")
            : trend.blind === "noAllocatable"
              ? t("empty", "nodeNoAllocatable")
              : trend.newestAgoMs !== null
                ? t("empty", "nodeNoSamplesYet", {
                    age: agoOf(now - trend.newestAgoMs, now),
                    range,
                  })
                : // Only where the staleness probe itself answered: a failed
                  // probe leaves every node looking never-seen.
                  trend.newestKnown
                  ? t("empty", "nodeNoSeries")
                  : t("empty", "nodeNotLooked")
          : trend.cordoned
            ? t("readings", "cordonedWord")
            : "–"}
      </TableCell>
    </TableRow>
  );
}

const BLIND_SHORT: Record<TrendBlind, keyof typeof en.empty> = {
  notLooked: "notLookedShort",
  noSeries: "noSeriesShort",
  noAllocatable: "noAllocatableShort",
};

function Lane({
  lane,
  blind,
}: {
  lane: TrendLane | null;
  blind: TrendBlind | null;
}) {
  const t = useT();
  if (lane === null) {
    return (
      <TableCell className="text-[11px] text-fg-fnt">
        {t("empty", BLIND_SHORT[blind ?? "noSeries"])}
      </TableCell>
    );
  }
  return (
    <TableCell>
      <div className="flex items-center gap-3">
        <Sparkline points={lane.points} />
        <span className="font-mono text-[11px] tabular-nums text-fg-mut">
          {t("readings", "peakAvgPercent", {
            peak: Math.round(lane.peak),
            avg: Math.round(lane.avg),
          })}
        </span>
      </div>
    </TableCell>
  );
}

const W = 120;
const H = 22;

/**
 * A line and nothing else: the numbers beside it carry the reading.
 *
 * Placed by time rather than by array index, and broken at every gap. By
 * index, an hour of samples inside a day-wide window was stretched across
 * the whole cell as though it covered it; joined through gaps, an outage was
 * drawn as a straight segment across the time nobody measured. A run of one
 * observed bucket is a dot — a one-point polyline draws nothing, which left
 * only the baseline and read as zero.
 */
function Sparkline({ points }: { points: readonly DeclaredPoint[] }) {
  const times = points.map((point) => point.t);
  const first = Math.min(...times);
  const span = Math.max(...times) - first;
  const xOf = (t: number) => (span === 0 ? W / 2 : ((t - first) / span) * W);
  const yOf = (v: number) => H - Math.min(100, Math.max(0, v)) * (H / 100);

  const runs: Array<Array<{ x: number; y: number }>> = [];
  let run: Array<{ x: number; y: number }> = [];
  for (const point of points) {
    if (point.v === null) {
      if (run.length > 0) runs.push(run);
      run = [];
      continue;
    }
    run.push({ x: xOf(point.t), y: yOf(point.v) });
  }
  if (run.length > 0) runs.push(run);
  return (
    <svg
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      className={cn("shrink-0 text-info")}
      aria-hidden="true"
    >
      <line
        x1={0}
        y1={H - 0.5}
        x2={W}
        y2={H - 0.5}
        stroke="hsl(var(--hair))"
        strokeWidth={1}
      />
      {runs.map((segment, index) =>
        segment.length === 1 ? (
          <circle
            key={index}
            cx={segment[0].x.toFixed(1)}
            cy={segment[0].y.toFixed(1)}
            r={1.25}
            fill="currentColor"
          />
        ) : (
          <polyline
            key={index}
            points={segment
              .map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`)
              .join(" ")}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.25}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        )
      )}
    </svg>
  );
}
