/**
 * What CloudNativePG's own kinds say about one object. `readCluster` and
 * `readPooler` are reused directly; a Cluster's rolled-up backup summary
 * needs the whole `Backup` list and is not attempted here. A `Backup` or
 * `ScheduledBackup` object still reports its own fields when the report is
 * about one of those.
 */

import { Database } from "lucide-react";

import type { T } from "@/i18n/useT";
import type { CustomResourceInfo } from "@/generated/types";
import { iconSvg } from "@/lib/icon-svg";
import { refOf } from "@/lib/report-parts";
import type { ReportSection, ReportValue } from "@/lib/report";
import { statusRole } from "@/lib/status-role";
import { GROUP } from "./data";
import { readCluster, readPooler } from "./model";

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

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function at(object: unknown, ...path: string[]): unknown {
  return path.reduce<unknown>(
    (current, key) =>
      current && typeof current === "object"
        ? (current as Record<string, unknown>)[key]
        : undefined,
    object
  );
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
  const cluster = readCluster(fakeResource(object));
  const rows: { label: string; values: ReportValue[] }[] = [
    {
      label: t("columns", "status"),
      values: [
        cluster.phase
          ? { text: cluster.phase, role: cluster.worst ?? "ok" }
          : { text: t("share", "notWrittenYet"), quiet: true },
      ],
    },
    {
      label: t("columns", "replicas"),
      values: [
        {
          text: `${cluster.ready}/${cluster.declared}`,
          role: cluster.ready === cluster.declared ? "ok" : "warn",
        },
      ],
    },
  ];
  if (cluster.primary) {
    rows.push({
      label: t("share", "cnpgPrimary"),
      values: [
        {
          text: cluster.primary,
          ref: refOf({
            kind: "Pod",
            name: cluster.primary,
            namespace: object.namespace,
          }),
        },
      ],
    });
  }
  if (cluster.postgresVersion) {
    rows.push({
      label: t("share", "cnpgVersion"),
      values: [{ text: cluster.postgresVersion, mono: true }],
    });
  }
  rows.push({
    label: t("share", "cnpgArchiving"),
    values: [
      cluster.archiving.status
        ? {
            text: cluster.archiving.status,
            role: cluster.archiving.status === "True" ? "ok" : "err",
          }
        : { text: t("share", "notWrittenYet"), quiet: true },
    ],
  });

  return [
    {
      id: "cnpg-cluster",
      title: "Cluster",
      icon: iconSvg(Database),
      body: { type: "facts", rows },
    },
    {
      id: "cnpg-cluster-instances",
      title: t("share", "cnpgInstances"),
      icon: iconSvg(Database),
      count: cluster.instances.length,
      body: {
        type: "table",
        columns: [
          t("columns", "name"),
          t("share", "cnpgRole"),
          t("columns", "status"),
        ],
        rows: cluster.instances.map((instance) => ({
          cells: [
            {
              text: instance.name,
              ref: refOf({
                kind: "Pod",
                name: instance.name,
                namespace: object.namespace,
              }),
            },
            { text: instance.role },
            { text: instance.health, role: statusRole(instance.health) },
          ],
        })),
        more: null,
      },
    },
  ];
}

function backupSections(spec: unknown, status: unknown, t: T): ReportSection[] {
  const phase = text(at(status, "phase"));
  const error = text(at(status, "error"));
  const method = text(at(spec, "method"));
  const rows: { label: string; values: ReportValue[] }[] = [
    {
      label: t("columns", "status"),
      values: [
        phase
          ? { text: phase, role: statusRole(phase) }
          : { text: t("share", "notWrittenYet"), quiet: true },
      ],
    },
  ];
  if (method)
    rows.push({
      label: t("share", "cnpgMethod"),
      values: [{ text: method, mono: true }],
    });
  if (error)
    rows.push({
      label: t("columns", "reason"),
      values: [{ text: error, role: "err" }],
    });
  return [
    {
      id: "cnpg-backup",
      title: "Backup",
      icon: iconSvg(Database),
      body: { type: "facts", rows },
    },
  ];
}

function scheduledBackupSections(
  spec: unknown,
  status: unknown,
  t: T
): ReportSection[] {
  const schedule = text(at(spec, "schedule"));
  const method = text(at(spec, "method"));
  const suspended = at(spec, "suspend") === true;
  const last = text(at(status, "lastScheduleTime"));
  const rows: { label: string; values: ReportValue[] }[] = [
    {
      label: t("columns", "status"),
      values: [
        suspended
          ? { text: t("action", "suspendedLower"), role: "warn" }
          : { text: schedule ?? "-", mono: true },
      ],
    },
  ];
  if (method)
    rows.push({
      label: t("share", "cnpgMethod"),
      values: [{ text: method, mono: true }],
    });
  if (last)
    rows.push({
      label: t("share", "cnpgLastScheduled"),
      values: [{ text: last }],
    });
  return [
    {
      id: "cnpg-scheduledbackup",
      title: "ScheduledBackup",
      icon: iconSvg(Database),
      body: { type: "facts", rows },
    },
  ];
}

function poolerSections(
  object: {
    namespace: string | null;
    name: string;
    kind: string;
    spec: unknown;
    status: unknown;
  },
  t: T
): ReportSection[] {
  const pooler = readPooler(fakeResource(object));
  const rows: { label: string; values: ReportValue[] }[] = [
    {
      label: t("share", "cnpgCluster"),
      values: pooler.cluster
        ? [
            {
              text: pooler.cluster,
              ref: refOf({
                kind: "Cluster",
                name: pooler.cluster,
                namespace: object.namespace,
              }),
            },
          ]
        : [{ text: t("empty", "none"), quiet: true }],
    },
  ];
  if (pooler.type)
    rows.push({
      label: t("columns", "kind"),
      values: [{ text: pooler.type, mono: true }],
    });
  if (pooler.poolMode)
    rows.push({
      label: t("share", "cnpgPoolMode"),
      values: [{ text: pooler.poolMode, mono: true }],
    });
  if (pooler.instances !== null) {
    rows.push({
      label: t("columns", "replicas"),
      values: [{ text: String(pooler.instances) }],
    });
  }
  return [
    {
      id: "cnpg-pooler",
      title: "Pooler",
      icon: iconSvg(Database),
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
    case "Cluster":
      return clusterSections(object, t);
    case "Backup":
      return backupSections(object.spec, object.status, t);
    case "ScheduledBackup":
      return scheduledBackupSections(object.spec, object.status, t);
    case "Pooler":
      return poolerSections(object, t);
    default:
      return null;
  }
}
