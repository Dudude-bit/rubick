import { useNavigate } from "react-router-dom";

import { Section, SectionBody, SectionHeader } from "@/components/ui/section";
import { Composition } from "@/components/resources/detail-blocks";
import { ResourceMessage } from "@/components/resources/ResourceMessage";
import {
  isRoutableKind,
  ResourceRef,
} from "@/components/resources/ResourceRef";
import { useShareSection } from "@/components/share/screen-share";
import {
  composedDetail,
  cpuRatio,
  deploymentSegments,
  memoryRatio,
  nodeSegments,
  nodesShare,
  podSegments,
  podTotal,
  PRESSURE_WARN,
  problemsShare,
  schedulerShare,
  warningsShare,
  workloadsShare,
  type Ratio,
} from "@/components/overview/health-share";
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

/**
 * The unit rides along dimmed and a size smaller, so the number keeps the
 * eye in a column of otherwise identical-looking quantities.
 */
function Unit({ children }: { children: React.ReactNode }) {
  return <span className="text-[0.85em] text-fg-fnt">{children}</span>;
}

const ROW =
  "grid grid-cols-[10px_150px_minmax(0,1fr)_60px_74px_46px] items-center gap-2.5 rounded-[5px] px-1.5 py-[5px] text-xs";

/**
 * A 60x14 trend line for one problem row.
 *
 * There is no history behind this: the backend returns a snapshot, so the
 * only shape the data justifies is "a pod that has already restarted is still
 * climbing", and everything else draws flat. Derived from the row beside it,
 * not telemetry — do not read it as a series, and do not add shapes no field
 * in `ClusterProblem` supports.
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
  const t = useT();
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
         *  keeps the colour — nothing may compete with the ranking on this
         *  screen — so the family contributes only its shape. */}
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
            {problem.detail.says === "said" ? (
              <ResourceMessage
                message={problem.detail.text}
                subject={{
                  kind: problem.kind,
                  name: problem.name,
                  namespace: problem.namespace,
                }}
              />
            ) : (
              composedDetail(problem.detail, t)
            )}
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
            <Unit> {t("count", "restartNoun", { n: restarts })}</Unit>
          </>
        ) : (
          "—"
        )}
      </span>
      <span className="text-right text-[11px] text-fg-fnt">
        {formatAge(problem.since, t)}
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
  nodesKnown,
}: {
  problems: ClusterProblem[];
  /** Rows the backend dropped from the end of the ranked list. */
  problemsTruncated: number;
  pods: PodComposition;
  nodes: NodeSummary[];
  /** False when the node list was refused: the "N nodes ready" half of the
   *  healthy line is unknown, not "0 of 0", so it is left off. */
  nodesKnown: boolean;
}) {
  const t = useT();
  useShareSection("overview-problems", () =>
    problemsShare(problems, problemsTruncated, t)
  );
  // The headline counts everything that is wrong, not everything that fits —
  // an outage that overflows the cap must not read as smaller than it is.
  const total = problems.length + problemsTruncated;
  const serving = pods.running - pods.crashLooping;
  const readyNodes = nodes.filter((n) => n.ready).length;

  return (
    <Section>
      <SectionHeader
        title={t("action", "needsAttention")}
        count={
          total > 0
            ? t("count", "worstFirst", { n: total })
            : t("empty", "nothingBroken")
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
            {t("count", "moreMostSevere", {
              n: problemsTruncated,
              shown: problems.length,
            })}
          </p>
        )}
        {/* What is fine gets one muted line at the end, never a panel of
         *  green checkmarks competing with the rows above it. */}
        <div className={ROW}>
          <span className="justify-self-center text-[9px] text-ok">{"●"}</span>
          <span className="truncate font-mono font-medium text-fg-mut">
            {t("cluster", "healthy")}
          </span>
          <span className="truncate text-fg-fnt">
            {t("count", "podsRunning", {
              n: serving,
              of: t("count", "ofPods", { n: podTotal(pods) }),
            })}
            {nodesKnown && (
              <>
                {" · "}
                {t("count", "nodesReady", {
                  n: readyNodes,
                  of: t("count", "ofNodes", { n: nodes.length }),
                })}
              </>
            )}
          </span>
          <span />
          <span />
          <span />
        </div>
      </div>
    </Section>
  );
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
  useShareSection("overview-workloads", () => workloadsShare(overview, t));

  return (
    <Section>
      <SectionHeader
        title={t("nav", "workloads")}
        count={
          problemsTruncated > 0
            ? `${scope} · +${t("count", "unrankedProblems", {
                n: problemsTruncated,
              })}`
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
          // `counts.nodes` is null when the node read was refused, so the bar
          // reads "— / not readable" like the other refused counts rather than
          // "0 Nodes". `nodes` is empty then, so its segments fall away.
          total={counts.nodes}
          label={counts.nodes === 1 ? "Node" : "Nodes"}
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
  const t = useT();
  useShareSection("overview-scheduler", () => schedulerShare(scheduler, t));
  return (
    <Section>
      {/* Naming the denominator matters: people read a low bar as "room to
       *  spare" and then wonder why the next pod sits Pending. */}
      <SectionHeader
        title={t("cluster", "schedulerHeadroom")}
        count={
          metricsAvailable
            ? t("cluster", "headroomLegend")
            : t("cluster", "headroomLegendNoMetrics")
        }
      />
      <div>
        <PressureRow label="CPU" pressure={scheduler.cpu} ratio={cpuRatio} />
        <PressureRow
          label={t("columns", "memory")}
          pressure={scheduler.memory}
          ratio={memoryRatio}
        />
      </div>
    </Section>
  );
}

function NodeRow({ node }: { node: NodeSummary }) {
  const t = useT();
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
        <Unit>
          {" "}
          {t("count", "podNoun", { n: node.podCapacity ?? node.podCount })}
        </Unit>
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
  const t = useT();
  useShareSection("overview-nodes", () => nodesShare(nodes, version, t));
  // Rendered in full, unlike the problems list: node counts are bounded in
  // practice, and a "+N more" would hide the node someone opened this panel
  // to find.
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

export function WarningsPanel({
  warnings,
  known,
}: {
  warnings: WarningGroup[];
  /** False when an events list failed or was cut short: the rows are
   *  then only part. */
  known: boolean;
}) {
  const t = useT();
  useShareSection("overview-warnings", () => warningsShare(warnings, known, t));
  if (known && warnings.length === 0) return null;

  return (
    <Section>
      <SectionHeader
        title={t("cluster", "warningEvents")}
        count={t("cluster", "warningEventsScope")}
      />
      {!known && (
        <p className="py-1 text-xs text-fg-mut">
          {t("cluster", "warningEventsUnread")}
        </p>
      )}
      {warnings.length > 0 && (
        <SectionBody>
          {warnings.map((warning) => (
            <WarningRow key={warning.reason} warning={warning} />
          ))}
        </SectionBody>
      )}
    </Section>
  );
}

function WarningRow({ warning }: { warning: WarningGroup }) {
  const t = useT();
  // Every row here is a Warning, so severity owns the colour outright and the
  // family mark contributes only shape.
  const { Icon } = eventReasonMark(warning.reason);
  // `showKind` stays on: nothing beside this name says the kind.
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
            {/* Names in the message are resolved against `subject`; a group
             *  carrying only a `"Kind/name"` string and no namespace leaves
             *  them nothing to resolve against. */}
            <ResourceMessage
              message={warning.sample}
              subject={subject ?? undefined}
            />
          </span>
        )}
      </span>
      <span className="text-right text-[11px] text-fg-fnt">
        {formatAge(warning.lastSeen, t)}
      </span>
    </div>
  );
}
