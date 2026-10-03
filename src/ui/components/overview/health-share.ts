import { Bell, Boxes, Gauge, Server, TriangleAlert } from "lucide-react";

import type { CompositionSegment } from "@/components/resources/detail-blocks";
import { iconSvg } from "@/lib/icon-svg";
import type { ReportEventRow, ReportFinding, ReportValue } from "@/lib/report";
import { ORDER, refOf, type PlacedSection } from "@/lib/report-parts";
import type { StatusRole } from "@/lib/status-role";
import { ResourceType } from "@/lib/resource-registry";
import type {
  ClusterOverview,
  ClusterProblem,
  NodeSummary,
  ProblemDetail,
  PodComposition,
  ResourcePressure,
  SchedulerPressure,
  WarningGroup,
} from "@/generated/types";
import type { T } from "@/i18n/useT";

/**
 * The detail line, for the rows this app writes itself.
 *
 * The `said` variant is deliberately not here: it carries the cluster's own
 * message, which `ResourceMessage` draws with the object names in it
 * turned into links. Only the sentences the app composes are looked up.
 */
export function composedDetail(
  detail: Exclude<ProblemDetail, { says: "said" }>,
  t: T
): string {
  switch (detail.says) {
    case "restarts":
      return t("readings", "problemRestarts", { n: detail.n });
    case "replicasReady":
      return t("readings", "problemReplicasReady", {
        ready: detail.ready,
        n: detail.desired,
      });
    case "unschedulable":
      return t("readings", "problemUnschedulable");
  }
}

/** Reserved share past which the scheduler is the binding constraint. */
export const PRESSURE_WARN = 0.85;

const KIB = 1024;
const MEMORY_UNITS: [string, number][] = [
  ["Ti", KIB ** 4],
  ["Gi", KIB ** 3],
  ["Mi", KIB ** 2],
  ["Ki", KIB],
];

/** A pair of quantities sharing one unit: `3.2/4.5 cores`, `27.4/31.2Gi`. */
export type Ratio = { used: string; total: string; unit: string };

export function cpuRatio(pressure: ResourcePressure): Ratio {
  // The unit is chosen from the denominator so both halves stay comparable –
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

export function memoryRatio(pressure: ResourcePressure): Ratio {
  const [unit, size] = MEMORY_UNITS.find(
    ([, size]) => pressure.allocatable >= size
  ) ?? ["B", 1];
  return {
    used: (pressure.requested / size).toFixed(1),
    total: (pressure.allocatable / size).toFixed(1),
    unit,
  };
}

/** What the "Needs attention" panel draws, as a Share finding per row. */
export function problemsShare(
  problems: ClusterProblem[],
  problemsTruncated: number,
  t: T
): PlacedSection {
  const items: ReportFinding[] = problems.map((problem) => ({
    title: problem.reason,
    detail:
      problem.detail === null
        ? null
        : problem.detail.says === "said"
          ? problem.detail.text
          : composedDetail(problem.detail, t),
    role: (problem.severity === "critical" ? "err" : "warn") as StatusRole,
    ref: refOf({
      kind: problem.kind,
      name: problem.name,
      namespace: problem.namespace,
    }),
  }));
  if (problemsTruncated > 0)
    items.push({
      title: t("count", "moreMostSevere", {
        n: problemsTruncated,
        shown: problems.length,
      }),
      detail: null,
      role: "neutral",
    });
  return {
    id: "overview-problems",
    order: ORDER.summary,
    title: t("action", "needsAttention"),
    icon: iconSvg(TriangleAlert),
    count: problems.length + problemsTruncated,
    body: { type: "findings", items },
  };
}

/** The phases partition the scope, so their sum is the pod count. */
export function podTotal(pods: PodComposition): number {
  return (
    pods.running + pods.pending + pods.succeeded + pods.failed + pods.unknown
  );
}

type Segment = CompositionSegment;

/**
 * Pods by phase.
 *
 * Phase separates a replica that is serving from a Job pod that ran and
 * finished; one "Healthy" bar over both overstates the running workload of
 * anyone with a nightly CronJob. Crash-loopers are carved back out of
 * Running: the phase says Running while the container is in a back-off loop
 * serving nothing.
 */
export function podSegments(pods: PodComposition): Segment[] {
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
export function deploymentSegments(
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

export function nodeSegments(nodes: NodeSummary[]): Segment[] {
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

function jobSegments(jobs: ClusterOverview["jobs"]): Segment[] {
  return jobs
    ? [
        { label: "Completed", count: jobs.completed, tone: "neutral" },
        { label: "Active", count: jobs.active, tone: "ok" },
        { label: "Failed", count: jobs.failed, tone: "err" },
      ]
    : [];
}

/** One composition row: what this scope has of one kind, or that the count could not be read. */
function compositionRow(
  label: string,
  total: number | null,
  segments: Segment[],
  t: T
): { label: string; values: ReportValue[] } {
  if (total === null)
    return { label, values: [{ text: t("share", "scrNotReadable") }] };
  const values = segments
    .filter((segment) => segment.count > 0)
    .map((segment): ReportValue => ({
      text: `${segment.count} ${segment.label}`,
      role: segment.tone,
    }));
  return {
    label,
    values: values.length > 0 ? values : [{ text: t("empty", "noneInScope") }],
  };
}

/** What the workload composition grid draws, as one row per kind. */
export function workloadsShare(overview: ClusterOverview, t: T): PlacedSection {
  const { counts, pods, jobs, nodes, problems } = overview;
  return {
    id: "overview-workloads",
    order: ORDER.own,
    title: t("nav", "workloads"),
    icon: iconSvg(Boxes),
    body: {
      type: "facts",
      rows: [
        compositionRow("Pods", podTotal(pods), podSegments(pods), t),
        compositionRow(
          "Deployments",
          counts.deployments,
          deploymentSegments(problems, counts.deployments),
          t
        ),
        compositionRow("Nodes", counts.nodes, nodeSegments(nodes), t),
        compositionRow("Jobs", counts.jobs, jobSegments(jobs), t),
      ],
    },
  };
}

/** What each pressure bar draws, as reserved-over-allocatable and the share. */
export function schedulerShare(
  scheduler: SchedulerPressure,
  t: T
): PlacedSection {
  const row = (
    label: string,
    pressure: ResourcePressure,
    ratio: (pressure: ResourcePressure) => Ratio
  ) => {
    const share =
      pressure.allocatable > 0 ? pressure.requested / pressure.allocatable : 0;
    const { used, total, unit } = ratio(pressure);
    return {
      label,
      values: [
        {
          text: `${used}/${total}${unit} · ${Math.round(share * 100)}%`,
          role: (share >= PRESSURE_WARN ? "warn" : undefined) as
            StatusRole | undefined,
        },
      ],
    };
  };
  return {
    id: "overview-scheduler",
    order: ORDER.own,
    title: t("cluster", "schedulerHeadroom"),
    icon: iconSvg(Gauge),
    body: {
      type: "facts",
      rows: [
        row("CPU", scheduler.cpu, cpuRatio),
        row(t("columns", "memory"), scheduler.memory, memoryRatio),
      ],
    },
  };
}

/** What each node row is, as its own table so a shared file lists every one. */
export function nodesShare(
  nodes: NodeSummary[],
  version: string | undefined,
  t: T
): PlacedSection {
  const word = (node: NodeSummary): { text: string; role: StatusRole } => {
    if (!node.ready) return { text: "NotReady", role: "err" };
    if (!node.schedulable)
      return { text: t("readings", "cordonedWord"), role: "warn" };
    return { text: "Ready", role: "ok" };
  };
  return {
    id: "overview-nodes",
    order: ORDER.own,
    title: "Nodes",
    icon: iconSvg(Server),
    count: nodes.length,
    body: {
      type: "table",
      columns: [
        t("columns", "node"),
        t("columns", "status"),
        t("columns", "roles"),
        t("columns", "pods"),
      ],
      rows: nodes.map((node) => ({
        cells: [
          {
            text: node.name,
            ref: refOf({
              kind: ResourceType.Node,
              name: node.name,
              namespace: null,
            }),
          },
          word(node),
          { text: node.roles.join(", "), quiet: true },
          {
            text:
              node.podCapacity != null
                ? `${node.podCount}/${node.podCapacity}`
                : String(node.podCount),
          },
        ],
      })),
      more: version ? `Kubernetes ${version}` : null,
    },
  };
}

/** What the feed of warnings draws, as events with the object each is about. */
export function warningsShare(
  warnings: WarningGroup[],
  known: boolean,
  t: T
): PlacedSection {
  const rows: ReportEventRow[] = warnings.map((warning) => ({
    at: warning.lastSeen,
    role: "warn",
    reason: warning.reason,
    message: warning.sample ?? "",
    count: warning.count,
    ref:
      warning.objectKind && warning.objectName
        ? refOf({
            kind: warning.objectKind,
            name: warning.objectName,
            namespace: warning.namespace,
          })
        : undefined,
  }));
  return {
    id: "overview-warnings",
    order: ORDER.events,
    title: t("cluster", "warningEvents"),
    icon: iconSvg(Bell),
    count: warnings.length,
    unread: known ? null : t("cluster", "warningEventsUnread"),
    body: { type: "events", rows },
  };
}
