import { useMemo, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { TriangleAlert } from "lucide-react";

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
import { objectLink, pageLink, type AppLink } from "@/lib/links";
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
import { sayWords } from "@/i18n/say";
import type { en } from "@/i18n/catalogue";
import { None } from "@/components/ui/none";
import { Alert } from "@/components/ui/alert";
import { Reading, SegmentedControl } from "@/components/ui/states";
import { TextSkeleton } from "@/components/ui/skeleton";
import { Unknown } from "@/components/ui/unknown";

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
  onRetryNodes?: () => void;
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
  onRetryNodes,
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
              : ready && query.isPending
                ? t("share", "stillReading")
                : null,
        range,
      },
      t
    )
  );

  // Before anything about Prometheus: with no node list there is nothing to
  // put a lane against, and an empty table here reads as "this cluster has
  // no nodes" — which is the node list's failure wearing the cluster's face.
  if (!nodesKnown) {
    return nodesReason ? (
      <Unknown
        question={t("empty", "nodesNotListedForTrends")}
        error={nodesReason}
        onRetry={onRetryNodes}
      />
    ) : (
      <div className="space-y-3 px-1 py-2">
        <Reading>{t("action", "reading")}</Reading>
        <TextSkeleton lines={6} />
      </div>
    );
  }

  if (power.state === "absent") {
    return (
      <p className="px-1 py-6 text-xs text-fg-mut">
        {parts(t("empty", "trendsNeedPrometheus"), {
          link: (
            <Link
              {...pageLink("integrations")}
              className="text-info hover:underline"
            >
              {t("action", "connectOne")}
            </Link>
          ),
        })}
      </p>
    );
  }

  return (
    <div>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-1 pb-2 text-caption text-fg-fnt">
        <span>{t("empty", "trendsSortNote")}</span>
        {power.state === "ready" && (
          <span>
            {t("count", "fromEndpoint", { endpoint: power.endpoint })}
            {query.data ? ` · ${sayWords(query.data.resolution, t)}` : ""}
          </span>
        )}
        <span className="ml-auto flex items-center gap-2">
          {query.isFetching && (
            <Reading className="text-micro">
              {t("action", "readingInline")}
            </Reading>
          )}
          <SegmentedControl
            label={t("columns", "usage")}
            value={range}
            onChange={onRange}
            mono
            segments={TREND_RANGES.map((candidate) => ({
              value: candidate,
              label: candidate,
            }))}
          />
        </span>
      </div>
      {power.state === "unreachable" && (
        <Alert variant="warn" role="status" className="mb-2">
          {t("empty", "vendorDidNotAnswer", {
            vendor: power.vendor,
            reason: power.reason,
          })}
        </Alert>
      )}
      {query.error && (
        <Alert variant="warn" role="status" className="mb-2">
          {t("empty", "vendorDidNotAnswer", {
            vendor: power.state === "ready" ? power.vendor : "",
            reason: errorToShow(query.error),
          })}
        </Alert>
      )}
      {power.state === "ready" && fromPods && (
        <p className="px-1 pb-2 text-caption text-fg-mut" role="note">
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
              note={noted ? (notes[index] ?? <None />) : null}
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
  page: AppLink | null;
}) {
  const t = useT();
  const mono = (text: string) => (
    <code className="font-mono text-fg-mut">{text}</code>
  );
  const monitors = `${vendor} › ${t("monitors", "tabMonitors")}`;
  return (
    <Alert variant="warn" role="status" className="mb-2">
      <TriangleAlert aria-hidden />
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
            <Link {...page} className="text-info hover:underline">
              {monitors}
            </Link>
          ) : (
            monitors
          ),
        })}
      </p>
    </Alert>
  );
}

function Row({
  trend,
  quiet,
  note,
}: {
  trend: NodeTrend;
  quiet: boolean;
  note: ReactNode;
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
          {...objectLink({ kind: ResourceType.Node, name: trend.node.name })!}
          className="font-mono text-xs text-fg hover:underline"
        >
          {trend.node.name}
        </Link>
        {facts && (
          <span className="ml-2 text-caption text-fg-fnt">{facts}</span>
        )}
      </TableCell>
      <Lane lane={trend.cpu} blind={trend.blind} quiet={quiet} />
      <Lane lane={trend.memory} blind={trend.blind} quiet={quiet} />
      {note != null && (
        <TableCell className="text-caption text-fg-fnt">{note}</TableCell>
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
      <TableCell className="text-caption text-fg-fnt">
        {quiet ? <None /> : t("empty", BLIND_SHORT[blind ?? "noSeries"])}
      </TableCell>
    );
  }
  return (
    <TableCell>
      <div className="flex items-center gap-3">
        <Sparkline points={lane.points} />
        <span className="font-mono text-caption tabular-nums text-fg-mut">
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
