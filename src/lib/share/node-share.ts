import { Ban, Boxes, Network } from "lucide-react";

import type { NodeInfo, PodInfo, TaintInfo } from "@/generated/types";
import type { T } from "@/i18n/useT";
import { iconSvg } from "@/lib/icon-svg";
import {
  formatCPU,
  formatMemory,
  parseCPU,
  parseMemory,
} from "@/lib/k8s-quantity";
import { nodePlacement, statesPlacement } from "@/lib/node-pool";
import { nodeReadyWord } from "@/lib/node-reporting";
import type { ReportStat, ReportValue } from "@/lib/report";
import { ORDER, refOf, type PlacedSection } from "@/lib/report-parts";
import { statusRole, type StatusRole } from "@/lib/status-role";
import { formatSince } from "@/lib/utils";

const PRESSURE = new Set(["memorypressure", "diskpressure", "pidpressure"]);
const normalize = (type: string) => type.toLowerCase().replace(/[\s_-]/g, "");

/**
 * `nodeReadyWord` alone misses pressure: a node can be `Ready` while its
 * kubelet is refusing new pods over memory, and the badge said nothing.
 */
export function nodeStatusOf(node: NodeInfo): {
  text: string;
  role: StatusRole;
} {
  const word = nodeReadyWord(node);
  const pressure = node.status.conditions
    .filter((c) => PRESSURE.has(normalize(c.type)) && c.status === "True")
    .map((c) => c.type);
  if (!node.status.ready) return { text: word, role: "err" };
  if (pressure.length > 0)
    return { text: `${word} · ${pressure.join(", ")}`, role: "warn" };
  return { text: word, role: statusRole(word) };
}

export function nodeStatsOf(
  node: NodeInfo,
  usage: { cpuMillicores: number | null; memoryBytes: number | null } | null,
  podCount: number | undefined,
  t: T
): ReportStat[] {
  const placement = nodePlacement(node);
  const podCapacity = Number(node.allocatable.pods ?? node.capacity.pods);
  const stats: ReportStat[] = [
    {
      label: t("columns", "roles"),
      value: node.roles.length > 0 ? node.roles.join(", ") : "–",
    },
    { label: t("share", "clKubernetesVersion"), value: node.version },
    { label: t("columns", "os"), value: `${node.os}/${node.arch}` },
    { label: t("columns", "containerRuntime"), value: node.containerRuntime },
  ];
  if (statesPlacement(placement)) {
    if (placement.pool)
      stats.push({ label: t("columns", "pool"), value: placement.pool });
    if (placement.machine)
      stats.push({
        label: t("columns", "instanceType"),
        value: placement.machine,
      });
    if (placement.zone)
      stats.push({ label: t("columns", "zone"), value: placement.zone });
    if (placement.spot)
      stats.push({
        label: t("columns", "spotNode"),
        value: t("cluster", "spotNodeWarning"),
      });
  }
  if (podCount !== undefined && Number.isFinite(podCapacity)) {
    stats.push({
      label: t("columns", "pods"),
      value: `${podCount}/${podCapacity}`,
      role: podCount >= podCapacity ? "warn" : undefined,
    });
  }
  const cpu = usage?.cpuMillicores;
  if (cpu !== null && cpu !== undefined) {
    const allocatable = node.allocatable.cpu
      ? parseCPU(node.allocatable.cpu)
      : null;
    stats.push({
      label: t("columns", "cpu"),
      value:
        allocatable !== null
          ? `${formatCPU(cpu)} / ${formatCPU(allocatable)}`
          : formatCPU(cpu),
    });
  }
  const memory = usage?.memoryBytes;
  if (memory !== null && memory !== undefined) {
    const allocatable = node.allocatable.memory
      ? parseMemory(node.allocatable.memory)
      : null;
    stats.push({
      label: t("columns", "memory"),
      value:
        allocatable !== null
          ? `${formatMemory(memory)} / ${formatMemory(allocatable)}`
          : formatMemory(memory),
    });
  }
  return stats;
}

export function taintsSection(taints: TaintInfo[], t: T): PlacedSection | null {
  if (taints.length === 0) return null;
  return {
    id: "taints",
    order: ORDER.own,
    title: t("columns", "taints"),
    icon: iconSvg(Ban),
    count: taints.length,
    body: {
      type: "table",
      columns: [
        t("share", "clKeyColumn"),
        t("columns", "value"),
        t("share", "clEffectColumn"),
      ],
      rows: taints.map((taint) => ({
        cells: [
          { text: taint.key, mono: true },
          { text: taint.value ?? "–" },
          {
            text: taint.effect,
            role: taint.effect === "PreferNoSchedule" ? undefined : "warn",
          },
        ],
      })),
      more: null,
    },
  };
}

const MAX_PODS = 100;

/**
 * The pods list is fetched only while the Pods tab is open, so before that
 * `pods` is `undefined`, read as "not looked at", never as "no pods here".
 */
export function podsOnNodeSection(
  pods: PodInfo[] | undefined,
  errorText: string | null,
  t: T
): PlacedSection {
  const kept = (pods ?? []).slice(0, MAX_PODS);
  const unread =
    errorText ?? (pods === undefined ? t("share", "clPodsNotOpened") : null);
  return {
    id: "node-pods",
    order: ORDER.own,
    title: t("share", "clSectionPodsOnNode"),
    icon: iconSvg(Boxes),
    count: pods?.length,
    unread,
    body: {
      type: "table",
      columns: [
        t("columns", "name"),
        t("columns", "status"),
        t("columns", "restarts"),
        t("columns", "age"),
      ],
      rows: kept.map((pod) => ({
        cells: [
          {
            text: pod.name,
            ref: refOf({
              kind: "Pod",
              name: pod.name,
              namespace: pod.namespace,
            }),
          },
          { text: pod.status.display, role: statusRole(pod.status.display) },
          {
            text: String(pod.restartCount),
            mono: true,
            quiet: pod.restartCount === 0,
          },
          {
            text: pod.createdAt
              ? formatSince(Date.parse(pod.createdAt), Date.now())
              : "–",
          },
        ],
      })),
      more:
        pods && pods.length > kept.length
          ? t("share", "rowsMore", { n: pods.length - kept.length })
          : null,
    },
  };
}

export function nodeAddressesFacts(node: NodeInfo, t: T): PlacedSection | null {
  const address = (type: string) =>
    node.status.addresses.find((a) => a.type === type)?.address ?? null;
  const internal = address("InternalIP");
  const external = address("ExternalIP");
  const hostname = address("Hostname");
  const rows: { label: string; values: ReportValue[] }[] = [];
  if (internal)
    rows.push({
      label: t("columns", "internalIp"),
      values: [{ text: internal, mono: true }],
    });
  if (external)
    rows.push({
      label: t("columns", "externalIp"),
      values: [{ text: external, mono: true }],
    });
  if (hostname)
    rows.push({
      label: t("columns", "hostname"),
      values: [{ text: hostname, mono: true }],
    });
  if (rows.length === 0) return null;
  return {
    id: "addresses",
    order: ORDER.own,
    title: t("columns", "addresses"),
    icon: iconSvg(Network),
    body: { type: "facts", rows },
  };
}
