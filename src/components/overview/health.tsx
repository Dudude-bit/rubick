import { Link } from "react-router-dom";

import { Section, SectionBody, SectionHeader } from "@/components/ui/section";
import { cn, formatAge } from "@/lib/utils";
import {
  ResourceType,
  toPlural,
  type ResourceKind,
} from "@/lib/resource-registry";
import type {
  ClusterProblem,
  NodeSummary,
  ResourcePressure,
  SchedulerPressure,
  WarningGroup,
} from "@/generated/types";

/** Reserved share past which the scheduler is the binding constraint. */
const PRESSURE_WARN = 0.85;

const KIB = 1024;
const MEMORY_UNITS: [string, number][] = [
  ["Ti", KIB ** 4],
  ["Gi", KIB ** 3],
  ["Mi", KIB ** 2],
  ["Ki", KIB],
];

/**
 * The unit rides along dimmed and a size smaller, so the number keeps the
 * eye in a column of otherwise identical-looking quantities.
 */
function Unit({ children }: { children: React.ReactNode }) {
  return <span className="text-[0.85em] text-fg-fnt">{children}</span>;
}

/** A pair of quantities sharing one unit: `3.2/4.5 cores`, `27.4/31.2Gi`. */
type Ratio = { used: string; total: string; unit: string };

function cpuRatio(pressure: ResourcePressure): Ratio {
  // The unit is chosen from the denominator so both halves stay comparable —
  // "250m/4.5 cores" makes the reader do the conversion.
  if (pressure.allocatable >= 1000) {
    return {
      used: (pressure.requested / 1000).toFixed(1),
      total: (pressure.allocatable / 1000).toFixed(1),
      unit: " cores",
    };
  }
  return {
    used: String(Math.round(pressure.requested)),
    total: String(Math.round(pressure.allocatable)),
    unit: "m",
  };
}

function memoryRatio(pressure: ResourcePressure): Ratio {
  const [unit, size] = MEMORY_UNITS.find(
    ([, size]) => pressure.allocatable >= size
  ) ?? ["B", 1];
  return {
    used: (pressure.requested / size).toFixed(1),
    total: (pressure.allocatable / size).toFixed(1),
    unit,
  };
}

const DETAIL_ROUTE: Record<string, ResourceKind | undefined> = {
  Pod: ResourceType.Pod,
  Deployment: ResourceType.Deployment,
  Node: ResourceType.Node,
};

/** Deep link to the offending object, when the app has a page for its kind. */
function problemHref(problem: ClusterProblem): string | null {
  const type = DETAIL_ROUTE[problem.kind];
  if (!type) return null;
  if (problem.kind === "Node") return `/${toPlural(type)}/${problem.name}`;
  if (!problem.namespace) return null;
  return `/${toPlural(type)}/${problem.namespace}/${problem.name}`;
}

const ROW =
  "grid grid-cols-[10px_150px_minmax(0,1fr)_60px_74px_46px] items-center gap-2.5 rounded-[5px] px-1.5 py-[5px] text-xs";

/**
 * A 60x14 trend line for one problem row.
 *
 * There is no history behind this. The backend returns a snapshot, so the
 * only shape that can be justified from the data is "a pod that has already
 * restarted is still climbing"; everything else draws flat. It is derived
 * from the row next to it, not measured telemetry — do not read it as a
 * series, and do not add shapes that no field in `ClusterProblem` supports.
 */
function Sparkline({
  rising,
  className,
}: {
  rising: boolean;
  className: string;
}) {
  return (
    <svg
      width="60"
      height="14"
      viewBox="0 0 60 14"
      className={cn("block", className)}
      aria-hidden="true"
    >
      <polyline
        points={
          rising
            ? "0,12 10,12 20,10 30,8 40,5 50,3 60,1"
            : "0,7 10,7 20,7 30,7 40,7 50,7 60,7"
        }
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
    </svg>
  );
}

function ProblemRow({ problem }: { problem: ClusterProblem }) {
  const isCritical = problem.severity === "critical";
  const tone = isCritical ? "text-err" : "text-warn";
  const href = problemHref(problem);
  const restarts = problem.restarts ?? 0;

  const body = (
    <>
      {/* Shape carries the severity alongside the colour: a red/green
       *  deficiency must not flatten the only ranking on this screen. */}
      <span className={cn("justify-self-center text-[9px]", tone)}>
        {isCritical ? "●" : "▲"}
      </span>
      <span className={cn("truncate font-mono font-medium", tone)}>
        {problem.reason}
      </span>
      <span className="truncate text-fg-mid">
        {problem.name}
        {problem.namespace && (
          <span className="text-fg-fnt"> · {problem.namespace}</span>
        )}
        {problem.detail && (
          <span className="text-fg-fnt"> — {problem.detail}</span>
        )}
      </span>
      <Sparkline
        rising={problem.kind === "Pod" && restarts > 0}
        className={tone}
      />
      <span className="text-right font-mono text-fg-mut">
        {restarts > 0 ? (
          <>
            {restarts}
            <Unit> restarts</Unit>
          </>
        ) : (
          "—"
        )}
      </span>
      <span className="text-right text-[11px] text-fg-fnt">
        {formatAge(problem.since)}
      </span>
    </>
  );

  if (!href) return <div className={ROW}>{body}</div>;
  return (
    <Link to={href} className={cn(ROW, "hover:bg-hover")}>
      {body}
    </Link>
  );
}

export function ProblemsPanel({
  problems,
  problemsTruncated,
  podCount,
  nodes,
}: {
  problems: ClusterProblem[];
  /** Rows the backend dropped from the end of the ranked list. */
  problemsTruncated: number;
  podCount: number;
  nodes: NodeSummary[];
}) {
  // The headline counts everything that is wrong, not everything that fits —
  // an outage that overflows the cap must not read as smaller than it is.
  const total = problems.length + problemsTruncated;
  const healthyPods = Math.max(0, podCount - countPodProblems(problems));
  const readyNodes = nodes.filter((n) => n.ready).length;

  return (
    <Section>
      <SectionHeader
        title="Needs attention"
        count={total > 0 ? `${total} · worst first` : "nothing broken"}
      />
      <div>
        {problems.map((problem) => (
          <ProblemRow
            key={`${problem.kind}/${problem.namespace ?? "-"}/${problem.name}/${problem.reason}`}
            problem={problem}
          />
        ))}
        {problemsTruncated > 0 && (
          <p className="px-1.5 py-[5px] text-[11px] text-fg-fnt">
            +{problemsTruncated} more — showing the {problems.length} most
            severe
          </p>
        )}
        {/* What is fine gets one muted line at the end, never a panel of
         *  green checkmarks competing with the rows above it. */}
        <div className={ROW}>
          <span className="justify-self-center text-[9px] text-ok">{"●"}</span>
          <span className="truncate font-mono font-medium text-fg-mut">
            Healthy
          </span>
          <span className="truncate text-fg-fnt">
            {healthyPods} of {podCount} pods · {readyNodes} of {nodes.length}{" "}
            nodes ready
          </span>
          <span />
          <span />
          <span />
        </div>
      </div>
    </Section>
  );
}

/** Pods the ranked list already accounts for, so they are not counted twice. */
function countPodProblems(problems: ClusterProblem[]): number {
  return problems.filter((p) => p.kind === "Pod").length;
}

type Tone = "ok" | "warn" | "err" | "neutral";
type Segment = { label: string; count: number; tone: Tone };

const BAR_TONE: Record<Tone, string> = {
  ok: "bg-ok",
  warn: "bg-warn",
  err: "bg-err",
  neutral: "bg-fg-fnt",
};

/** Only the abnormal segments carry colour; the healthy majority stays quiet. */
const LEGEND_TONE: Record<Tone, string> = {
  ok: "text-fg-fnt",
  warn: "text-warn",
  err: "text-err",
  neutral: "text-fg-fnt",
};

function Composition({
  total,
  label,
  segments,
}: {
  total: number;
  label: string;
  segments: Segment[];
}) {
  const visible = segments.filter((s) => s.count > 0);

  return (
    <div>
      <div className="flex items-baseline gap-1.5">
        <span className="font-mono text-[15px] font-semibold text-fg">
          {total}
        </span>
        <span className="text-[11px] text-fg-mut">{label}</span>
      </div>
      <div className="mb-1.5 mt-[7px] flex h-[3px] overflow-hidden rounded-sm bg-sel">
        {visible.map((segment) => (
          <span
            key={segment.label}
            className={BAR_TONE[segment.tone]}
            style={{ flex: segment.count }}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
        {visible.map((segment) => (
          <span key={segment.label} className={LEGEND_TONE[segment.tone]}>
            {segment.count} {segment.label}
          </span>
        ))}
      </div>
    </div>
  );
}

function podSegments(problems: ClusterProblem[], podCount: number): Segment[] {
  // Grouped by the reason the backend already computed — "3 CrashLoopBackOff"
  // is a different problem from "1 Pending" even though both are red.
  const byReason = new Map<string, Segment>();
  for (const problem of problems) {
    if (problem.kind !== "Pod") continue;
    const existing = byReason.get(problem.reason);
    if (existing) {
      existing.count += 1;
      continue;
    }
    byReason.set(problem.reason, {
      label: problem.reason,
      count: 1,
      tone: problem.severity === "critical" ? "err" : "warn",
    });
  }
  // Everything the problem pass did not flag. Succeeded pods land here too:
  // the backend does not report phase, so the remainder is "not broken"
  // rather than "Running", and is labelled as such.
  const healthy = Math.max(0, podCount - countPodProblems(problems));
  return [
    { label: "Healthy", count: healthy, tone: "ok" },
    ...[...byReason.values()].sort((a, b) => b.count - a.count),
  ];
}

function nodeSegments(nodes: NodeSummary[]): Segment[] {
  return [
    {
      label: "Ready",
      count: nodes.filter((n) => n.ready && n.schedulable).length,
      tone: "ok",
    },
    {
      label: "Cordoned",
      count: nodes.filter((n) => n.ready && !n.schedulable).length,
      tone: "warn",
    },
    {
      label: "NotReady",
      count: nodes.filter((n) => !n.ready).length,
      tone: "err",
    },
  ];
}

/**
 * Composition of what this scope is made of.
 *
 * Only the kinds `get_cluster_overview` can account for in full are shown.
 * Deployments and Jobs appear in the payload only when they are already
 * broken, so their totals are unknown and a bar drawn from the problem list
 * alone would claim the cluster has as many deployments as it has failures.
 */
export function WorkloadsPanel({
  problems,
  problemsTruncated,
  podCount,
  nodes,
  scope,
}: {
  problems: ClusterProblem[];
  problemsTruncated: number;
  podCount: number;
  nodes: NodeSummary[];
  scope: string;
}) {
  return (
    <Section>
      <SectionHeader
        title="Workloads"
        count={
          problemsTruncated > 0
            ? `${scope} · +${problemsTruncated} unranked problems`
            : scope
        }
      />
      <div className="grid grid-cols-4 gap-[22px]">
        <Composition
          total={podCount}
          label={podCount === 1 ? "Pod" : "Pods"}
          segments={podSegments(problems, podCount)}
        />
        <Composition
          total={nodes.length}
          label={nodes.length === 1 ? "Node" : "Nodes"}
          segments={nodeSegments(nodes)}
        />
      </div>
    </Section>
  );
}

function PressureRow({
  label,
  pressure,
  ratio: format,
}: {
  label: string;
  pressure: ResourcePressure;
  ratio: (pressure: ResourcePressure) => Ratio;
}) {
  const share =
    pressure.allocatable > 0 ? pressure.requested / pressure.allocatable : 0;
  const usedShare =
    pressure.allocatable > 0 && pressure.usage != null
      ? pressure.usage / pressure.allocatable
      : null;
  const tight = share >= PRESSURE_WARN;
  const { used, total, unit } = format(pressure);

  return (
    <div className="grid grid-cols-[92px_minmax(0,1fr)_150px] items-center gap-3 px-1.5 py-1">
      <span className="text-[11px] text-fg-mut">{label}</span>
      <span className="relative h-[5px] overflow-hidden rounded-[3px] bg-sel">
        <span
          className={cn(
            "absolute inset-y-0 left-0 rounded-[3px]",
            tight ? "bg-warn" : "bg-info"
          )}
          style={{ width: `${Math.min(100, share * 100)}%` }}
        />
        {/* Live usage is a tick, not a second bar: it is context for the
         *  reserved number, not a competing metric. */}
        {usedShare != null && (
          <span
            className="absolute inset-y-0 w-0.5 bg-fg-mid"
            style={{ left: `${Math.min(100, usedShare * 100)}%` }}
          />
        )}
      </span>
      <span className="text-right font-mono text-[11px] text-fg-mut">
        {used}
        <Unit>/</Unit>
        {total}
        <Unit>{unit}</Unit> · {Math.round(share * 100)}
        <Unit>%</Unit>
      </span>
    </div>
  );
}

export function SchedulerPanel({
  scheduler,
  metricsAvailable,
}: {
  scheduler: SchedulerPressure;
  metricsAvailable: boolean;
}) {
  return (
    <Section>
      {/* Naming the denominator matters: people read a low bar as "room to
       *  spare" and then wonder why the next pod sits Pending. */}
      <SectionHeader
        title="Scheduler headroom"
        count={
          metricsAvailable
            ? "requests vs allocatable · tick marks live usage"
            : "requests vs allocatable · no metrics-server, live usage unknown"
        }
      />
      <div>
        <PressureRow label="CPU" pressure={scheduler.cpu} ratio={cpuRatio} />
        <PressureRow
          label="Memory"
          pressure={scheduler.memory}
          ratio={memoryRatio}
        />
      </div>
    </Section>
  );
}

function NodeRow({ node }: { node: NodeSummary }) {
  return (
    <Link
      to={`/${toPlural(ResourceType.Node)}/${node.name}`}
      className="grid grid-cols-[7px_minmax(0,1fr)_auto] items-center gap-2.5 rounded-[5px] px-1.5 py-[5px] text-xs hover:bg-hover"
    >
      <span
        className={cn(
          "h-[7px] w-[7px] rounded-full",
          node.ready ? "bg-ok" : "bg-err"
        )}
        aria-hidden="true"
      />
      <span className="flex min-w-0 items-baseline gap-2">
        <span className="truncate font-mono">{node.name}</span>
        {node.roles.map((role) => (
          <span key={role} className="text-[11px] text-fg-fnt">
            {role}
          </span>
        ))}
        {!node.schedulable && (
          <span className="text-[11px] text-warn">cordoned</span>
        )}
        {!node.ready && <span className="text-[11px] text-err">NotReady</span>}
      </span>
      <span className="text-right font-mono text-[11px] text-fg-mut">
        {node.podCount}
        {node.podCapacity != null && (
          <>
            <Unit>/</Unit>
            {node.podCapacity}
          </>
        )}
        <Unit> pods</Unit>
      </span>
    </Link>
  );
}

export function NodesPanel({
  nodes,
  version,
}: {
  nodes: NodeSummary[];
  /** Server version, shown here rather than in a page title of its own. */
  version?: string;
}) {
  // Rendered in full, unlike the problems list: node counts are bounded in
  // practice, and hiding one behind a "+N more" would hide the node someone
  // opened this panel to find.
  return (
    <Section>
      <SectionHeader
        title="Nodes"
        count={
          version ? `${nodes.length} · Kubernetes ${version}` : nodes.length
        }
      />
      <div>
        {nodes.map((node) => (
          <NodeRow key={node.name} node={node} />
        ))}
      </div>
    </Section>
  );
}

export function WarningsPanel({ warnings }: { warnings: WarningGroup[] }) {
  if (warnings.length === 0) return null;

  return (
    <Section>
      <SectionHeader title="Warning events" count="last hour, by reason" />
      <SectionBody>
        {warnings.map((warning) => (
          <div
            key={warning.reason}
            className="grid grid-cols-[150px_minmax(0,1fr)_46px] items-center gap-2.5 px-1.5 py-[5px] text-xs"
          >
            <span className="truncate font-mono font-medium text-warn">
              {warning.reason}
              {warning.count > 1 && <Unit> ×{warning.count}</Unit>}
            </span>
            <span className="truncate text-fg-mid">
              {warning.object && (
                <span className="font-mono">{warning.object}</span>
              )}
              {warning.object && warning.sample && " "}
              {warning.sample && (
                <span className="text-fg-fnt">{warning.sample}</span>
              )}
            </span>
            <span className="text-right text-[11px] text-fg-fnt">
              {formatAge(warning.lastSeen)}
            </span>
          </div>
        ))}
      </SectionBody>
    </Section>
  );
}
