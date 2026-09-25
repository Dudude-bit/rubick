/**
 * What Scylla's own kinds say about one object, reusing `readScyllaCluster`
 * and `readNodeConfig`, the same readers the Clusters page walks, against a
 * `CustomResourceInfo` built from the bare `spec`/`status` `object.report`
 * hands over.
 */

import { Layers } from "lucide-react";

import type { T } from "@/i18n/useT";
import type { CustomResourceInfo } from "@/generated/types";
import { iconSvg } from "@/lib/icon-svg";
import type { ReportSection, ReportValue } from "@/lib/report";
import { GROUP } from "./data";
import { readNodeConfig, readScyllaCluster } from "./model";

function fakeResource(object: {
  namespace: string | null;
  name: string;
  kind: string;
  spec: unknown;
  status: unknown;
}): CustomResourceInfo {
  return {
    name: object.name,
    namespace: object.namespace,
    uid: "",
    apiVersion: `${GROUP}/v1`,
    kind: object.kind,
    spec: object.spec,
    status: object.status,
    labels: {},
    annotations: {},
    createdAt: null,
    ownerReferences: [],
    generation: null,
  };
}

function clusterSections(
  object: {
    namespace: string | null;
    name: string;
    kind: string;
    spec: unknown;
    status: unknown;
  },
  t: T
): ReportSection[] {
  const cluster = readScyllaCluster(fakeResource(object));
  // `Available` is healthy `True`; `Degraded` is healthy `False`; `Progressing`
  // is neither, work in flight rather than a fault either way it reads.
  const conditionValue = (
    status: string | null,
    healthyValue: "True" | "False" | null
  ): ReportValue =>
    status === null
      ? { text: t("share", "notWrittenYet"), quiet: true }
      : {
          text: status,
          role:
            status === "Unknown"
              ? "warn"
              : healthyValue === null
                ? "neutral"
                : status === healthyValue
                  ? "ok"
                  : "err",
        };
  const rows: { label: string; values: ReportValue[] }[] = [
    {
      label: "Available",
      values: [conditionValue(cluster.conditions.available, "True")],
    },
    {
      label: "Degraded",
      values: [conditionValue(cluster.conditions.degraded, "False")],
    },
    {
      label: "Progressing",
      values: [conditionValue(cluster.conditions.progressing, null)],
    },
    {
      label: t("share", "scyllaMembers"),
      values: [
        {
          text: `${cluster.readyMembers ?? "?"}/${cluster.members ?? "?"}`,
          role:
            cluster.readyMembers === null || cluster.members === null
              ? "neutral"
              : cluster.readyMembers === cluster.members
                ? "ok"
                : "warn",
        },
      ],
    },
  ];
  if (cluster.version)
    rows.push({
      label: t("share", "scyllaVersion"),
      values: [{ text: cluster.version, mono: true }],
    });
  if (cluster.datacenter)
    rows.push({
      label: t("share", "scyllaDatacenter"),
      values: [{ text: cluster.datacenter, mono: true }],
    });
  if (cluster.upgrade) {
    rows.push({
      label: t("share", "scyllaUpgrade"),
      values: [
        {
          text: `${cluster.upgrade.fromVersion ?? "?"} → ${cluster.upgrade.toVersion ?? "?"}`,
          role: "warn",
        },
      ],
    });
  }

  return [
    {
      id: "scylla-cluster",
      title: "ScyllaCluster",
      icon: iconSvg(Layers),
      body: { type: "facts", rows },
    },
    {
      id: "scylla-cluster-racks",
      title: t("share", "scyllaRacks"),
      icon: iconSvg(Layers),
      count: cluster.racks.length,
      body: {
        type: "table",
        columns: [
          t("columns", "name"),
          t("share", "scyllaMembers"),
          t("share", "scyllaVersion"),
        ],
        rows: cluster.racks.map((rack) => ({
          cells: [
            { text: rack.name },
            {
              text: `${rack.ready ?? "?"}/${rack.members}`,
              role:
                rack.ready === null
                  ? "neutral"
                  : rack.ready === rack.members
                    ? "ok"
                    : "warn",
            },
            { text: rack.version ?? "-", mono: true },
          ],
        })),
        more: null,
      },
    },
  ];
}

function nodeConfigSections(
  object: {
    namespace: string | null;
    name: string;
    kind: string;
    spec: unknown;
    status: unknown;
  },
  t: T
): ReportSection[] {
  const config = readNodeConfig(fakeResource(object));
  const rows: { label: string; values: ReportValue[] }[] = [
    {
      label: t("share", "scyllaNodes"),
      values: [
        {
          text: `${config.tuned ?? "?"}/${config.nodes ?? "?"}`,
          role:
            config.problems.length > 0
              ? "err"
              : config.tuned === null || config.nodes === null
                ? "neutral"
                : config.tuned === config.nodes
                  ? "ok"
                  : "warn",
        },
      ],
    },
  ];
  for (const problem of config.problems) {
    rows.push({
      label: problem.type,
      values: [
        { text: problem.message ?? t("share", "notWrittenYet"), role: "err" },
      ],
    });
  }
  return [
    {
      id: "scylla-nodeconfig",
      title: "NodeConfig",
      icon: iconSvg(Layers),
      body: { type: "facts", rows },
    },
  ];
}

export function reportOf(
  object: {
    group: string;
    kind: string;
    namespace: string | null;
    name: string;
    spec: unknown;
    status: unknown;
  },
  t: T
): ReportSection[] | null {
  if (object.group !== GROUP) return null;
  switch (object.kind) {
    case "ScyllaCluster":
      return clusterSections(object, t);
    case "NodeConfig":
      return nodeConfigSections(object, t);
    default:
      return null;
  }
}
