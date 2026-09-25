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
import { useShareSection } from "@/components/share/screen-share";
import { nodeUtilisationSections } from "./node-utilisation-share";
import { useCapabilityState, USAGE_RANGES } from "@/integrations";
import type { DeclaredPoint, UsageRange } from "@/integrations";
import { errorToShow } from "@/lib/error-utils";
import { getResourceDetailUrl } from "@/lib/navigation-utils";
import {
  everyNodeSilent,
  nodeTrends,
  type NodeTrend,
  type TrendBlind,
  type TrendLane,
} from "@/lib/node-trends";
import { nodePlacement } from "@/lib/node-pool";
import { ResourceType } from "@/lib/resource-registry";
import { formatSince } from "@/lib/utils";
import { cn } from "@/lib/utils";
import type { NodeInfo } from "@/generated/types";
import { useT, type T } from "@/i18n/useT";
import { parts } from "@/i18n/parts";
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
  const silent = windowKnown && everyNodeSilent(query.data ?? null, trends);
  const notes = trends.map((trend) => noteOf(trend, now, range, t));
  const noted = notes.some((note) => note !== null);
  const fromPods =
    query.data?.basis === "pods" && Object.keys(query.data.nodes).length > 0;

  useShareSection("utilisation", () =>
    nodeUtilisationSections(
      {
        trends,
        notes,
        fromPods,
        silent,
        vendor: power.state === "absent" ? null : power.vendor,
        capable: power.state !== "absent",
        unread: !nodesKnown
          ? nodesReason
            ? t("empty", "nodesDidNotList", { reason: nodesReason })
            : t("action", "reading")
          : power.state === "unreachable"
            ? t("empty", "vendorDidNotAnswer", {
                vendor: power.vendor,
                reason: power.reason,
              })
            : query.error
              ? t("empty", "vendorDidNotAnswer", {
                  vendor: power.state === "ready" ? power.vendor : "",
                  reason: errorToShow(query.error),
                })
              : null,
      },
      t
    )
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
            reason: errorToShow(query.error),
          })}
        </p>
      )}
      {power.state === "ready" && fromPods && (
        <p className="px-1 pb-2 text-[11px] text-fg-mut" role="note">
          {t("empty", "nodesFromPods", { vendor: power.vendor })}
        </p>
      )}
      {power.state === "ready" && silent && (
        <SilentNodes vendor={power.vendor} page={power.page} />
      )}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("columns", "node")}</TableHead>
            <TableHead>{t("columns", "cpuOfAllocatable")}</TableHead>
            <TableHead>{t("columns", "memoryOfAllocatable")}</TableHead>
            {noted && <TableHead>{t("columns", "note")}</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {trends.map((trend, index) => (
            <Row
              key={trend.node.name}
              trend={trend}
              quiet={silent}
              note={noted ? (notes[index] ?? "–") : null}
            />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/** What a row says that its CPU and Memory cells cannot, or `null`. */
function noteOf(
  trend: NodeTrend,
  now: number,
  range: UsageRange,
  t: T
): string | null {
  if (trend.blind === "noAllocatable") return t("empty", "nodeNoAllocatable");
  if (trend.blind === "noSeries" && trend.newestAgoMs !== null) {
    return t("empty", "nodeNoSamplesYet", {
      age: formatSince(now - trend.newestAgoMs, now),
      range,
    });
  }
  return null;
}

const CPU_METRIC = "container_cpu_usage_seconds_total";
const MEMORY_METRIC = "container_memory_working_set_bytes";

/** One answer for every row, said once: what was asked, why it is likely empty, where to look. */
function SilentNodes({
  vendor,
  page,
}: {
  vendor: string;
  page: string | null;
}) {
  const t = useT();
  const mono = (text: string) => (
    <code className="font-mono text-fg-mut">{text}</code>
  );
  const monitors = `${vendor} › ${t("monitors", "tabMonitors")}`;
  return (
    <div
      className="mb-2 rounded border border-hair border-l-2 border-l-warn px-3 py-2 text-xs"
      role="status"
    >
      <p className="text-fg">{t("empty", "nodesSilentTitle", { vendor })}</p>
      <p className="mt-1 text-fg-mut">
        {parts(t("empty", "nodesSilentAsked"), {
          cpu: mono(CPU_METRIC),
          memory: mono(MEMORY_METRIC),
          root: mono('id="/"'),
        })}
      </p>
      <p className="mt-1 text-fg-mut">
        {t("empty", "nodesSilentReason", { vendor })}
      </p>
      <p className="mt-1 text-fg-mut">
        {parts(t("empty", "nodesSilentCheck"), {
          monitors: page ? (
            <Link to={page} className="text-info hover:underline">
              {monitors}
            </Link>
          ) : (
            monitors
          ),
        })}
      </p>
    </div>
  );
}

function Row({
  trend,
  quiet,
  note,
}: {
  trend: NodeTrend;
  quiet: boolean;
  note: string | null;
}) {
  const t = useT();
  const placement = nodePlacement(trend.node);
  const facts = [
    placement.pool,
    placement.machine,
    placement.spot ? "spot" : null,
    trend.cordoned ? t("readings", "cordonedWord") : null,
  ]
    .filter((f): f is string => !!f)
    .join(" · ");
  return (
    <TableRow data-quiet>
      <TableCell>
        <Link
          to={getResourceDetailUrl(ResourceType.Node, trend.node.name)}
          className="font-mono text-xs text-fg hover:underline"
        >
          {trend.node.name}
        </Link>
        {facts && <span className="ml-2 text-[11px] text-fg-fnt">{facts}</span>}
      </TableCell>
      <Lane lane={trend.cpu} blind={trend.blind} quiet={quiet} />
      <Lane lane={trend.memory} blind={trend.blind} quiet={quiet} />
      {note !== null && (
        <TableCell className="text-[11px] text-fg-fnt">{note}</TableCell>
      )}
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
  quiet,
}: {
  lane: TrendLane | null;
  blind: TrendBlind | null;
  quiet: boolean;
}) {
  const t = useT();
  if (lane === null) {
    return (
      <TableCell className="text-[11px] text-fg-fnt">
        {quiet ? "–" : t("empty", BLIND_SHORT[blind ?? "noSeries"])}
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
