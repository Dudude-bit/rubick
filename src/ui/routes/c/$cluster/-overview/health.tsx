import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { Loader2, Lock, TriangleAlert } from "lucide-react";

import { Section, SectionBody, SectionHeader } from "@/components/ui/section";
import { Composition } from "@/components/object/detail-blocks";
import { ResourceMessage } from "@/components/object/ResourceMessage";
import { ResourceRef } from "@/components/object/ResourceRef";
import { KindIcon } from "@/components/object/KindIcon";
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
  attentionShare,
  schedulerShare,
  warningsShare,
  workloadsShare,
  type Ratio,
} from "./health-share";
import { eventReasonMark } from "@/lib/event-reason";
import {
  foldedWords,
  type Attention,
  type AttentionCheck,
  type AttentionItem,
} from "@/lib/attention";
import { ERROR_CODES } from "@/lib/error-utils";
import { listLink, objectLink } from "@/lib/links";
import {
  ROLE_DOT,
  ROLE_ICON,
  ROLE_TEXT,
  type StatusRole,
} from "@/lib/status-role";
import { cn, formatAge } from "@/lib/utils";
import { getDisplayPlural, ResourceType } from "@/lib/resource-registry";
import type {
  ClusterOverview,
  NodeSummary,
  PodComposition,
  ResourcePressure,
  SchedulerPressure,
  WarningGroup,
} from "@/generated/types";
import { useT, type T } from "@/i18n/useT";

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

const VISIBLE = 12;

function AttentionDetailText({ item }: { item: AttentionItem }) {
  const t = useT();
  const { detail } = item;
  if (!detail) return null;
  if (detail.says === "said")
    return (
      <ResourceMessage
        message={detail.text}
        subject={{
          kind: item.kind,
          name: item.name,
          namespace: item.namespace,
        }}
      />
    );
  if (detail.says === "ours") return <>{detail.text}</>;
  return <>{composedDetail(detail, t)}</>;
}

function AttentionRow({ item }: { item: AttentionItem }) {
  const t = useT();
  const navigate = useNavigate();
  const tone = ROLE_TEXT[item.tone];
  const SeverityIcon = ROLE_ICON[item.tone];
  const link = objectLink(item.opens);
  const restarts = item.restarts ?? 0;
  const { Icon: ReasonIcon } = eventReasonMark(item.reason);
  const elsewhere =
    item.opens.kind !== item.kind || item.opens.name !== item.name;

  const body = (
    <>
      {/* Shape carries the severity alongside the colour: a red/green
       *  deficiency must not flatten the only ranking on this screen. */}
      <SeverityIcon
        className={cn("h-3 w-3 justify-self-center", tone)}
        aria-hidden="true"
      />
      <span
        className={cn(
          "inline-flex min-w-0 items-baseline gap-1 font-mono font-medium",
          tone
        )}
      >
        <ReasonIcon
          className="h-2.5 w-2.5 flex-none self-center"
          aria-hidden="true"
        />
        <span className="truncate" title={item.reason}>
          {item.reason}
        </span>
      </span>
      <span className="truncate text-fg-mid">
        <ResourceRef
          kind={item.kind}
          name={item.name}
          namespace={item.namespace}
          showKind={false}
        />
        {elsewhere && (
          <>
            <span className="text-fg-fnt">{" → "}</span>
            <ResourceRef
              kind={item.opens.kind}
              name={item.opens.name}
              namespace={item.opens.namespace}
              showKind={false}
            />
          </>
        )}
        {item.namespace && (
          <span className="text-fg-fnt"> · {item.namespace}</span>
        )}
        {item.foldedPods !== null && (
          <span className="text-fg-mut"> · {foldedWords(item, t)}</span>
        )}
        {item.detail && (
          <span className="text-fg-fnt">
            {": "}
            <AttentionDetailText item={item} />
          </span>
        )}
      </span>
      <Sparkline
        rising={item.kind === "Pod" && restarts > 0}
        className={tone}
      />
      <span className="text-right font-mono text-fg-mut">
        {restarts > 0 ? (
          <>
            {restarts}
            <Unit> {t("count", "restartNoun", { n: restarts })}</Unit>
          </>
        ) : (
          <span className="text-fg-fnt">·</span>
        )}
      </span>
      <span className="text-right text-[11px] text-fg-fnt">
        {item.since === null ? "·" : formatAge(item.since, t)}
      </span>
    </>
  );

  if (link === null) return <div className={ROW}>{body}</div>;
  // The row opens the object's page; the name inside it opens the peek.
  return (
    <div
      role="link"
      tabIndex={0}
      onClick={(event) => {
        if ((event.target as HTMLElement).closest("a")) return;
        navigate(link);
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter") return;
        navigate(link);
      }}
      className={cn(ROW, "cursor-pointer hover:bg-hover")}
    >
      {body}
    </div>
  );
}

/**
 * The rows past the cap, by kind, each a way into its list. The count opens
 * the rows this list holds in place; what the backend cut has only a count.
 */
function MoreRows({
  hidden,
  cut,
  onExpand,
}: {
  hidden: AttentionItem[];
  cut: number;
  onExpand: () => void;
}) {
  const t = useT();
  const byKind = new Map<string, number>();
  for (const item of hidden)
    byKind.set(item.kind, (byKind.get(item.kind) ?? 0) + 1);
  const more = t("cluster", "attentionMore", { n: hidden.length + cut });
  return (
    <p className="flex flex-wrap items-baseline gap-x-2 px-1.5 py-[5px] text-[11px] text-fg-fnt">
      {hidden.length > 0 ? (
        <button
          type="button"
          aria-expanded={false}
          onClick={onExpand}
          className="rounded text-fg-mut underline decoration-hair underline-offset-2 transition-colors hover:text-fg focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-info"
        >
          {more}
        </button>
      ) : (
        <span>{more}</span>
      )}
      {[...byKind].map(([kind, n]) => (
        <Link
          key={kind}
          {...listLink(kind)}
          className="inline-flex items-center gap-1 text-fg-mut hover:text-fg"
        >
          <KindIcon kind={kind} className="h-2.5 w-2.5" />
          <span className="font-mono">
            {n} {n === 1 ? kind : getDisplayPlural(kind)}
          </span>
        </Link>
      ))}
    </p>
  );
}

function scopeOf(unread: AttentionCheck["unread"], t: T): string | null {
  const named = [
    ...new Set(
      unread.flatMap((entry) => (entry.namespace ? [entry.namespace] : []))
    ),
  ];
  if (named.length === 0) return null;
  return named.length === 1
    ? t("cluster", "attentionInNamespace", { namespace: named[0] })
    : t("cluster", "attentionInNamespaces", { n: named.length });
}

/** One kind the list could not look at: refused, failed, or not answered yet. */
function CheckRow({ check }: { check: AttentionCheck }) {
  const t = useT();
  const reading = check.state === "reading";
  const refused =
    !reading &&
    check.unread.length > 0 &&
    check.unread.every((entry) => entry.code === ERROR_CODES.PERMISSION);
  const Icon = reading ? Loader2 : refused ? Lock : TriangleAlert;
  const said = check.unread.find((entry) => entry.message)?.message ?? null;
  const where = scopeOf(check.unread, t);
  return (
    <li className="grid grid-cols-[10px_150px_minmax(0,1fr)] items-baseline gap-2.5 px-1.5 py-[3px] text-xs">
      <Icon
        className={cn(
          "h-3 w-3 self-center justify-self-center",
          reading
            ? "animate-spin text-info"
            : refused
              ? "text-fg-mut"
              : "text-warn"
        )}
        aria-hidden="true"
      />
      <span className="inline-flex min-w-0 items-baseline gap-1 font-mono text-fg-mid">
        <KindIcon
          kind={check.kind}
          className="h-2.5 w-2.5 flex-none self-center"
        />
        <span className="truncate">{getDisplayPlural(check.kind)}</span>
      </span>
      <span className="min-w-0 truncate text-fg-mut" title={said ?? undefined}>
        {t(
          "cluster",
          reading
            ? "attentionStillReading"
            : refused
              ? "attentionRefused"
              : "attentionFailed"
        )}
        {where && <span className="text-fg-fnt"> {where}</span>}
        {said && (
          <span className="font-mono text-[11px] text-fg-fnt">
            {": "}
            {said}
          </span>
        )}
      </span>
    </li>
  );
}

/** The word beside the summary dot: none while rows above it carry the verdict. */
const SUMMARY_LABEL: Record<StatusRole, "healthy" | "attentionPartly" | null> =
  {
    ok: "healthy",
    neutral: "attentionPartly",
    pending: null,
    warn: null,
    err: null,
  };

/** Not-running pods by phase, in the words the composition bar uses. */
function notRunning(pods: PodComposition): string {
  return podSegments(pods)
    .filter((segment) => segment.label !== "Running" && segment.count > 0)
    .map((segment) => `${segment.count} ${segment.label}`)
    .join(", ");
}

export function AttentionPanel({
  attention,
  pods,
  nodes,
  nodesKnown,
}: {
  attention: Attention;
  pods: PodComposition;
  nodes: NodeSummary[];
  /** False when the node list was refused: the "N nodes ready" half of the
   *  summary is unknown, not "0 of 0", so it is left off. */
  nodesKnown: boolean;
}) {
  const t = useT();
  useShareSection("overview-problems", () => attentionShare(attention, t));
  const { items, total, complete, worst } = attention;
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? items : items.slice(0, VISIBLE);
  const hidden = expanded ? [] : items.slice(VISIBLE);
  const cut = total - items.length;
  const unchecked = attention.checks.filter((check) => check.state !== "read");
  const serving = pods.running - pods.crashLooping;
  const readyNodes = nodes.filter((n) => n.ready).length;
  const down = notRunning(pods);
  const summaryRole: StatusRole = worst ?? (complete ? "ok" : "neutral");

  return (
    <Section>
      <SectionHeader
        title={t("action", "needsAttention")}
        count={
          total > 0
            ? t("count", "worstFirst", { n: total })
            : complete
              ? t("cluster", "attentionNothing")
              : t("cluster", "attentionNoneFound")
        }
      />
      <div>
        {shown.map((item) => (
          <AttentionRow key={item.key} item={item} />
        ))}
        {hidden.length + cut > 0 && (
          <MoreRows
            hidden={hidden}
            cut={cut}
            onExpand={() => setExpanded(true)}
          />
        )}
        {unchecked.length > 0 && (
          <div
            className="mt-1 border-t border-hair pt-1.5"
            data-testid="attention-unchecked"
          >
            <p className="px-1.5 pb-0.5 text-[11px] text-fg-fnt">
              {t("cluster", "attentionNotChecked")}
            </p>
            <ul>
              {unchecked.map((check) => (
                <CheckRow key={check.kind} check={check} />
              ))}
            </ul>
          </div>
        )}
        {/* What is fine gets one muted line at the end, never a panel of
         *  green checkmarks competing with the rows above it. Its dot is the
         *  list's verdict: green only when everything named was read clean. */}
        <div className={ROW} data-testid="attention-summary">
          <span
            className={cn(
              "h-[7px] w-[7px] justify-self-center rounded-full",
              ROLE_DOT[summaryRole]
            )}
            aria-hidden="true"
          />
          <span className="truncate font-mono font-medium text-fg-mut">
            {SUMMARY_LABEL[summaryRole] &&
              t("cluster", SUMMARY_LABEL[summaryRole])}
          </span>
          <span className="truncate text-fg-fnt">
            {t("count", "podsRunning", {
              n: serving,
              of: t("count", "ofPods", { n: podTotal(pods) }),
            })}
            {down && <> ({down})</>}
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

/** The panel while this scope's own answer is on its way: the last scope's would be the wrong list. */
export function AttentionPending() {
  const t = useT();
  return (
    <Section>
      <SectionHeader title={t("action", "needsAttention")} />
      <p className="flex items-center gap-2 px-1.5 py-[5px] text-xs text-fg-mut">
        <Loader2
          className="h-3 w-3 animate-spin text-info"
          aria-hidden="true"
        />
        {t("cluster", "attentionStillReading")}
      </p>
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
    navigate(objectLink({ kind: ResourceType.Node, name: node.name })!);
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
    <div className="grid grid-cols-[260px_minmax(0,1fr)_46px] items-center gap-2.5 px-1.5 py-[5px] text-xs">
      {/* 260px holds FailedComputeMetricsReplicas and its count whole. */}
      <span className="inline-flex min-w-0 items-baseline gap-1 font-mono font-medium text-warn">
        <Icon
          className="h-2.5 w-2.5 flex-none self-center"
          aria-hidden="true"
        />
        <span className="truncate" title={warning.reason}>
          {warning.reason}
        </span>
        {warning.count > 1 && (
          <span className="flex-none">
            <Unit>×{warning.count}</Unit>
          </span>
        )}
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
