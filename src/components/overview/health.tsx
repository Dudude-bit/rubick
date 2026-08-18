import { useNavigate } from "react-router-dom";

import { Section, SectionBody, SectionHeader } from "@/components/ui/section";
import {
  Composition,
  type CompositionSegment,
} from "@/components/resources/detail-blocks";
import { ResourceMessage } from "@/components/resources/ResourceMessage";
import {
  isRoutableKind,
  ResourceRef,
} from "@/components/resources/ResourceRef";
import { eventReasonMark } from "@/lib/event-reason";
import { getResourceDetailUrl } from "@/lib/navigation-utils";
import { cn, formatAge } from "@/lib/utils";
import { ResourceType } from "@/lib/resource-registry";
import type {
  ClusterOverview,
  ClusterProblem,
  NodeSummary,
  PodComposition,
  ResourcePressure,
  SchedulerPressure,
  WarningGroup,
} from "@/generated/types";
import { useT } from "@/i18n/useT";

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
  const navigate = useNavigate();
  const isCritical = problem.severity === "critical";
  const tone = isCritical ? "text-err" : "text-warn";
  const routable = isRoutableKind(problem.kind, problem.namespace);
  const restarts = problem.restarts ?? 0;
  const { Icon: ProblemIcon } = eventReasonMark(problem.reason);

  const body = (
    <>
      {/* Shape carries the severity alongside the colour: a red/green
       *  deficiency must not flatten the only ranking on this screen. */}
      <span className={cn("justify-self-center text-[9px]", tone)}>
        {isCritical ? "●" : "▲"}
      </span>
      <span
        className={cn(
          "inline-flex min-w-0 items-baseline gap-1 font-mono font-medium",
          tone
        )}
      >
        {/* The same family mark the event feed gives this reason. Severity
         *  keeps the colour — the ranking on this screen is by severity and
         *  nothing may compete with it — so the family contributes only its
         *  shape, exactly as it does on a Warning in the feed. */}
        <ProblemIcon
          className="h-2.5 w-2.5 flex-none self-center"
          aria-hidden="true"
        />
        <span className="truncate">{problem.reason}</span>
      </span>
      <span className="truncate text-fg-mid">
        <ResourceRef
          kind={problem.kind}
          name={problem.name}
          namespace={problem.namespace}
          showKind={false}
        />
        {problem.namespace && (
          <span className="text-fg-fnt"> · {problem.namespace}</span>
        )}
        {problem.detail && (
          <span className="text-fg-fnt">
            {" — "}
            <ResourceMessage
              message={problem.detail}
              subject={{
                kind: problem.kind,
                name: problem.name,
                namespace: problem.namespace,
              }}
            />
          </span>
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

  if (!routable) return <div className={ROW}>{body}</div>;
  // The row opens the object's page; the name inside it opens the peek.
  return (
    <div
      role="link"
      tabIndex={0}
      onClick={(event) => {
        if ((event.target as HTMLElement).closest("a")) return;
        navigate(
          getResourceDetailUrl(problem.kind, problem.name, problem.namespace)
        );
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter") return;
        navigate(
          getResourceDetailUrl(problem.kind, problem.name, problem.namespace)
        );
      }}
      className={cn(ROW, "cursor-pointer hover:bg-hover")}
    >
      {body}
    </div>
  );
}

export function ProblemsPanel({
  problems,
  problemsTruncated,
  pods,
  nodes,
}: {
  problems: ClusterProblem[];
  /** Rows the backend dropped from the end of the ranked list. */
  problemsTruncated: number;
  pods: PodComposition;
  nodes: NodeSummary[];
}) {
  const t = useT();
  // The headline counts everything that is wrong, not everything that fits —
  // an outage that overflows the cap must not read as smaller than it is.
  const total = problems.length + problemsTruncated;
  const serving = pods.running - pods.crashLooping;
  const readyNodes = nodes.filter((n) => n.ready).length;

  return (
    <Section>
      <SectionHeader
        title="Needs attention"
        count={
          total > 0 ? `${total} · worst first` : t("empty", "nothingBroken")
        }
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
            {serving} of {podTotal(pods)} pods running · {readyNodes} of{" "}
            {nodes.length} nodes ready
          </span>
          <span />
          <span />
          <span />
        </div>
      </div>
    </Section>
  );
}

/** The phases partition the scope, so their sum is the pod count. */
function podTotal(pods: PodComposition): number {
  return (
    pods.running + pods.pending + pods.succeeded + pods.failed + pods.unknown
  );
}

type Segment = CompositionSegment;

/**
 * Pods by phase.
 *
 * Phase is what separates a replica that is serving from a Job pod that ran
 * and finished — lumping both into one "Healthy" bar told anyone with a
 * nightly CronJob that they had more running workload than they do.
 * Crash-loopers are carved back out of Running: the phase says Running while
 * the container is in a back-off loop serving nothing.
 */
function podSegments(pods: PodComposition): Segment[] {
  return [
    { label: "Running", count: pods.running - pods.crashLooping, tone: "ok" },
    { label: "CrashLoop", count: pods.crashLooping, tone: "err" },
    { label: "Pending", count: pods.pending, tone: "warn" },
    { label: "Failed", count: pods.failed, tone: "err" },
    { label: "Completed", count: pods.succeeded, tone: "neutral" },
    { label: "Unknown", count: pods.unknown, tone: "neutral" },
  ];
}

/**
 * Deployments split into available and not.
 *
 * The unavailable half is the problem list, which the backend already ranked;
 * the available half is the total minus it, so the two agree by construction.
 */
function deploymentSegments(
  problems: ClusterProblem[],
  total: number | null
): Segment[] {
  const unavailable = problems.filter((p) => p.kind === "Deployment").length;
  return [
    {
      label: "Available",
      count: Math.max(0, (total ?? 0) - unavailable),
      tone: "ok",
    },
    { label: "Unavailable", count: unavailable, tone: "err" },
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

/** Composition of what this scope is made of. */
export function WorkloadsPanel({
  overview,
  scope,
}: {
  overview: ClusterOverview;
  scope: string;
}) {
  const t = useT();
  const { counts, pods, jobs, nodes, problems, problemsTruncated } = overview;
  const podCount = podTotal(pods);

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
          emptyMessage={t("empty", "noneInScope")}
          segments={podSegments(pods)}
        />
        <Composition
          total={counts.deployments}
          label={counts.deployments === 1 ? "Deployment" : "Deployments"}
          emptyMessage={t("empty", "noneInScope")}
          segments={deploymentSegments(problems, counts.deployments)}
        />
        <Composition
          total={nodes.length}
          label={nodes.length === 1 ? "Node" : "Nodes"}
          emptyMessage={t("empty", "noneInScope")}
          segments={nodeSegments(nodes)}
        />
        <Composition
          total={counts.jobs}
          label={counts.jobs === 1 ? "Job" : "Jobs"}
          emptyMessage={t("empty", "noneInScope")}
          segments={
            jobs
              ? [
                  {
                    label: "Completed",
                    count: jobs.completed,
                    tone: "neutral",
                  },
                  { label: "Active", count: jobs.active, tone: "ok" },
                  { label: "Failed", count: jobs.failed, tone: "err" },
                ]
              : []
          }
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
  const navigate = useNavigate();
  const open = () =>
    navigate(getResourceDetailUrl(ResourceType.Node, node.name));
  return (
    <div
      role="link"
      tabIndex={0}
      onClick={(event) => {
        if ((event.target as HTMLElement).closest("a")) return;
        open();
      }}
      onKeyDown={(event) => event.key === "Enter" && open()}
      className="grid cursor-pointer grid-cols-[7px_minmax(0,1fr)_auto] items-center gap-2.5 rounded-[5px] px-1.5 py-[5px] text-xs hover:bg-hover"
    >
      <span
        className={cn(
          "h-[7px] w-[7px] rounded-full",
          node.ready ? "bg-ok" : "bg-err"
        )}
        aria-hidden="true"
      />
      <span className="flex min-w-0 items-baseline gap-2">
        <ResourceRef
          kind={ResourceType.Node}
          name={node.name}
          showKind={false}
        />
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
    </div>
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
          <WarningRow key={warning.reason} warning={warning} />
        ))}
      </SectionBody>
    </Section>
  );
}

function WarningRow({ warning }: { warning: WarningGroup }) {
  // Every row here is a Warning, so severity owns the colour outright and the
  // family mark contributes only shape — the feed's rule, applied to the one
  // event surface that was still rendering a reason as a bare word.
  const { Icon } = eventReasonMark(warning.reason);
  // The same `Kind/name` this row always printed, now under the mark and hue
  // every other naming of the same object carries. `showKind` stays on for
  // exactly that reason: nothing beside it says the kind.
  const subject =
    warning.objectKind && warning.objectName
      ? {
          kind: warning.objectKind,
          name: warning.objectName,
          namespace: warning.namespace,
        }
      : null;

  return (
    <div className="grid grid-cols-[150px_minmax(0,1fr)_46px] items-center gap-2.5 px-1.5 py-[5px] text-xs">
      <span className="inline-flex min-w-0 items-baseline gap-1 font-mono font-medium text-warn">
        <Icon
          className="h-2.5 w-2.5 flex-none self-center"
          aria-hidden="true"
        />
        <span className="truncate">
          {warning.reason}
          {warning.count > 1 && <Unit> ×{warning.count}</Unit>}
        </span>
      </span>
      <span className="truncate text-fg-mid">
        {subject && (
          <ResourceRef
            kind={subject.kind}
            name={subject.name}
            namespace={subject.namespace}
          />
        )}
        {subject && warning.sample && " "}
        {warning.sample && (
          <span className="text-fg-fnt">
            {/* The panel above this one has linkified the same sentence since
             *  the segmenter shipped. It could not here because the group
             *  carried a `"Kind/name"` string and no namespace, so every name
             *  in the message had nothing to be resolved against. */}
            <ResourceMessage
              message={warning.sample}
              subject={subject ?? undefined}
            />
          </span>
        )}
      </span>
      <span className="text-right text-[11px] text-fg-fnt">
        {formatAge(warning.lastSeen)}
      </span>
    </div>
  );
}
