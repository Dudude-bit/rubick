import { Bell, Boxes, Gauge, Server, TriangleAlert } from "lucide-react";

import type { CompositionSegment } from "@/components/object/detail-blocks";
import { iconSvg } from "@/lib/icon-svg";
import type { ReportEventRow, ReportFinding, ReportValue } from "@/lib/report";
import { ORDER, refOf, type PlacedSection } from "@/lib/report-parts";
import { statusRole, type StatusRole } from "@/lib/status-role";
import { ownCountedWord } from "@/lib/status-words";
import type { WorkloadStatus } from "@/lib/workload-status";
import type { JobStatus } from "@/lib/status-meaning";
import {
  attentionLines,
  checkRefused,
  foldedWords,
  reasonWord,
  unreadWhere,
  type Attention,
  type AttentionDetail,
} from "@/lib/attention";
import { getDisplayPlural, ResourceType } from "@/lib/resource-registry";
import type {
  ClusterOverview,
  NodeSummary,
  ProblemDetail,
  PodComposition,
  ReasonCount,
  ResourcePressure,
  RolloutCount,
  SchedulerPressure,
  WarningGroup,
} from "@/generated/types";
import type { T } from "@/i18n/useT";
import { translate, type Locale } from "@/i18n";
import { currentLocale } from "@/stores/localeStore";
import { byteScale, formatBytes } from "@/lib/k8s-quantity";
import { splitUnit } from "@/lib/metric-format";
import { formatDecimal } from "@/lib/utils";

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

/** A row's detail as plain words, whoever wrote them. */
export function detailWords(
  detail: AttentionDetail | null,
  t: T
): string | null {
  if (detail === null) return null;
  return detail.says === "said" || detail.says === "ours"
    ? detail.text
    : composedDetail(detail, t);
}

/** Reserved share past which the scheduler is the binding constraint. */
export const PRESSURE_WARN = 0.85;

/** A pair of quantities sharing one unit: `3.2/4.5 cores`, `27.4/31.2Gi`. */
export type Ratio = { used: string; total: string; unit: string };

export function cpuRatio(
  pressure: ResourcePressure,
  locale: Locale = currentLocale()
): Ratio {
  // The unit is chosen from the denominator so both halves stay comparable:
  // "250m/4.5 cores" makes the reader do the conversion.
  if (pressure.allocatable >= 1000) {
    const cores = (millicores: number) =>
      formatDecimal(millicores / 1000, 1, locale);
    const { value, unit } = splitUnit(
      translate(locale, "cluster", "cpuCores", {
        cores: cores(pressure.allocatable),
      })
    );
    return { used: cores(pressure.requested), total: value, unit };
  }
  return {
    used: String(Math.round(pressure.requested)),
    total: String(Math.round(pressure.allocatable)),
    unit: "m",
  };
}

export function memoryRatio(
  pressure: ResourcePressure,
  locale: Locale = currentLocale()
): Ratio {
  const scale = byteScale(pressure.allocatable);
  const { value, unit } = splitUnit(
    formatBytes(pressure.allocatable, { scale, locale })
  );
  const used = splitUnit(formatBytes(pressure.requested, { scale, locale }));
  return { used: used.value, total: value, unit };
}

/** What the "Needs attention" panel draws, as a Share finding per row. */
export function attentionShare(attention: Attention, t: T): PlacedSection {
  const items = attentionLines(attention.items).map((line): ReportFinding => {
    if (line.at === "unserved")
      return {
        title: t("count", "ingressesUnserved", {
          n: line.members,
          classes: line.className,
        }),
        detail: t("empty", "nothingPickedThemUp"),
        role: "err",
      };
    const { item } = line;
    const marked = line.grouped ? item.unservedClass : undefined;
    return {
      title: marked
        ? `${reasonWord(item, t)} · ${marked.name}`
        : reasonWord(item, t),
      detail:
        [
          foldedWords(item, t),
          marked ? marked.rest : detailWords(item.detail, t),
        ]
          .filter((part) => part !== null)
          .join(" · ") || null,
      role: item.tone,
      ref: refOf({
        kind: item.kind,
        name: item.name,
        namespace: item.namespace,
      }),
    };
  });
  const cut = attention.total - attention.items.length;
  if (cut > 0)
    items.push({
      title: t("cluster", "attentionMore", { n: cut }),
      detail: null,
      role: "neutral",
    });
  for (const check of attention.checks) {
    if (check.state === "read") continue;
    const said =
      check.state === "reading"
        ? t("cluster", "attentionStillReading")
        : `${t(
            "cluster",
            checkRefused(check) ? "attentionRefused" : "attentionFailed"
          )} ${unreadWhere(check.unread, t)}`;
    items.push({
      title: `${getDisplayPlural(check.kind)}: ${said}`,
      detail: check.unread.find((entry) => entry.message)?.message ?? null,
      role: "neutral",
    });
  }
  return {
    id: "overview-problems",
    order: ORDER.summary,
    title: t("action", "needsAttention"),
    icon: iconSvg(TriangleAlert),
    count: attention.total,
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

/** Pods up and ready: Running, minus the crash-looping and the not ready. */
export function podsServing(pods: PodComposition): number {
  return pods.running - pods.crashLooping - pods.notReady;
}

/**
 * Pods by phase.
 *
 * Phase separates a replica that is serving from a Job pod that ran and
 * finished; one "Healthy" bar over both overstates the running workload of
 * anyone with a nightly CronJob. Crash-loopers and pods failing readiness
 * are carved back out of Running: the phase says Running while they serve
 * nothing. A pod held in an error that waiting will not clear is carved out
 * of Pending under that error, the word the Pods list prints for it, and one
 * still inside its wait as starting, which its workload says too.
 */
export function podSegments(pods: PodComposition, t: T): Segment[] {
  const stuck = pods.stuck.reduce((n, held) => n + held.count, 0);
  return [
    { label: "Running", count: podsServing(pods), tone: "ok" },
    { label: "NotReady", count: pods.notReady, tone: "warn" },
    { label: "CrashLoop", count: pods.crashLooping, tone: "err" },
    ...pods.stuck.map(({ reason, count }): Segment => ({
      label: reason,
      count,
      tone: "err",
    })),
    {
      label: t("statusWords", "startingCounted", { n: pods.starting }),
      count: pods.starting,
      tone: "pending",
    },
    {
      label: "Pending",
      count: pods.pending - stuck - pods.starting,
      tone: "warn",
    },
    { label: "Failed", count: pods.failed, tone: "err" },
    { label: "Completed", count: pods.succeeded, tone: "neutral" },
    { label: "Unknown", count: pods.unknown, tone: "neutral" },
  ];
}

const SEGMENT_TONE: Record<StatusRole, Segment["tone"]> = {
  ok: "ok",
  warn: "warn",
  err: "err",
  pending: "pending",
  neutral: "neutral",
};

const DEPLOYMENT_ORDER: Record<WorkloadStatus, number> = {
  Ready: 0,
  Progressing: 1,
  Paused: 2,
  Idle: 3,
  Waiting: 4,
  Degraded: 5,
  Unavailable: 6,
  Stalled: 7,
};

const JOB_ORDER: Record<JobStatus, number> = {
  Running: 0,
  Pending: 1,
  Retrying: 2,
  Suspended: 3,
  Complete: 4,
  Failed: 5,
};

/** One segment per word the kind's list prints, in the list's colour and in `order`. */
function wordSegments(
  counts: ReasonCount[] | null,
  order: Record<string, number>,
  t: T
): Segment[] {
  const rank = (code: string) => order[code] ?? Number.MAX_SAFE_INTEGER;
  return [...(counts ?? [])]
    .sort((a, b) => rank(a.reason) - rank(b.reason))
    .map(({ reason, count }) => ({
      label: ownCountedWord(reason, count, t) ?? reason,
      count,
      tone: SEGMENT_TONE[statusRole(reason)],
    }));
}

/**
 * Deployments by the rollout word the list and Needs attention print, each
 * counted apart. A word only the controller's counts stand behind, its pods
 * unread, is drawn as the list draws it: grey, with the not-read mark.
 */
export function deploymentSegments(
  deployments: RolloutCount[] | null,
  t: T
): Segment[] {
  const read = (deployments ?? []).filter((entry) => !entry.podsUnread);
  const unread = (deployments ?? [])
    .filter((entry) => entry.podsUnread)
    .map(({ reason, count }): Segment => ({
      label: `${ownCountedWord(reason, count, t) ?? reason} · ${t("readings", "rolloutPodsUnreadShort")}`,
      count,
      tone: "neutral",
      unread: true,
    }));
  return [...wordSegments(read, DEPLOYMENT_ORDER, t), ...unread];
}

/** Jobs by the word the Jobs list prints. */
export function jobSegments(jobs: ReasonCount[] | null, t: T): Segment[] {
  return wordSegments(jobs, JOB_ORDER, t);
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
      unread: segment.unread,
    }));
  return {
    label,
    values: values.length > 0 ? values : [{ text: t("empty", "noneInScope") }],
  };
}

/** What the workload composition grid draws, as one row per kind. */
export function workloadsShare(overview: ClusterOverview, t: T): PlacedSection {
  const { counts, pods, jobs, nodes } = overview;
  return {
    id: "overview-workloads",
    order: ORDER.own,
    title: t("nav", "workloads"),
    icon: iconSvg(Boxes),
    body: {
      type: "facts",
      rows: [
        compositionRow(
          "Pods",
          pods && podTotal(pods),
          pods ? podSegments(pods, t) : [],
          t
        ),
        compositionRow(
          "Deployments",
          counts.deployments,
          deploymentSegments(overview.deployments, t),
          t
        ),
        compositionRow("Nodes", counts.nodes, nodeSegments(nodes), t),
        compositionRow("Jobs", counts.jobs, jobSegments(jobs, t), t),
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
            | StatusRole
            | undefined,
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
