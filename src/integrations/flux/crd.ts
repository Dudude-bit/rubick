/**
 * Flux's Helm objects: HelmRelease, HelmRepository, HelmChart.
 *
 * A Flux-managed release is not in Helm's own storage in the shape the Helm
 * pages read, so these are where its chart, version and source actually are.
 */

import type { CrdColumn, CrdStatus } from "../kit";
import { getValueByPath, matchMultiple } from "../kit";
import type { CrdView } from "../registry";

/**
 * Status configuration for Flux resources (uses standard conditions)
 */
const fluxStatusConfig: CrdStatus = {
  getStatus: (resource) => {
    const conditions = getValueByPath(resource, "status.conditions") as
      Array<{ type: string; status: string; reason?: string }> | undefined;

    if (!Array.isArray(conditions)) return null;

    const readyCondition = conditions.find((c) => c.type === "Ready");
    if (readyCondition) {
      if (readyCondition.status === "True") return "Ready";
      if (readyCondition.reason === "Progressing") return "Progressing";
      return "NotReady";
    }

    const stalledCondition = conditions.find((c) => c.type === "Stalled");
    if (stalledCondition?.status === "True") return "Stalled";

    return "Unknown";
  },
  getVariant: (status) => {
    switch (status.toLowerCase()) {
      case "ready":
        return "default";
      case "progressing":
      case "reconciling":
        return "secondary";
      case "notready":
      case "stalled":
      case "failed":
        return "destructive";
      default:
        return "outline";
    }
  },
};

/**
 * Columns for HelmRelease list
 */
const helmReleaseColumns: CrdColumn[] = [
  {
    id: "ready",
    header: "ready",
    accessor: (resource) => {
      const conditions = getValueByPath(resource, "status.conditions") as
        Array<{ type: string; status: string; reason?: string }> | undefined;

      if (!Array.isArray(conditions)) return "Unknown";

      const readyCondition = conditions.find((c) => c.type === "Ready");
      if (!readyCondition) return "Unknown";

      if (readyCondition.status === "True") return "True";
      if (readyCondition.reason === "Progressing") return "Progressing";
      return "False";
    },
    cell: (value) => String(value ?? "-"),
  },
  {
    id: "chart",
    header: "chart",
    accessor: (resource) => {
      const chartSpec = getValueByPath(resource, "spec.chart.spec") as
        | {
            chart?: string;
            sourceRef?: { name: string };
          }
        | undefined;

      return chartSpec?.chart ?? "-";
    },
    cell: (value) => String(value ?? "-"),
  },
  {
    id: "version",
    header: "version",
    accessor: (resource) => {
      // Try to get installed version from status first
      const lastAppliedRevision = getValueByPath(
        resource,
        "status.lastAppliedRevision"
      ) as string | undefined;
      if (lastAppliedRevision) return lastAppliedRevision;

      // Fall back to spec version
      const chartSpec = getValueByPath(resource, "spec.chart.spec") as
        | {
            version?: string;
          }
        | undefined;

      return chartSpec?.version ?? "*";
    },
    cell: (value) => String(value ?? "-"),
  },
  {
    id: "sourceRef",
    header: "source",
    accessor: (resource) => {
      const chartSpec = getValueByPath(resource, "spec.chart.spec") as
        | {
            sourceRef?: { kind?: string; name: string };
          }
        | undefined;

      if (!chartSpec?.sourceRef) return "-";
      const kind = chartSpec.sourceRef.kind ?? "HelmRepository";
      return `${kind}/${chartSpec.sourceRef.name}`;
    },
    cell: (value) => String(value ?? "-"),
  },
  {
    id: "targetNamespace",
    header: "targetNS",
    accessor: (resource) => getValueByPath(resource, "spec.targetNamespace"),
    cell: (value) => String(value ?? "(same)"),
  },
  {
    id: "suspended",
    header: "suspended",
    accessor: (resource) => getValueByPath(resource, "spec.suspend") === true,
    cell: (value) => (value ? "Yes" : "No"),
  },
];

/**
 * Columns for HelmRepository list
 */
const helmRepositoryColumns: CrdColumn[] = [
  {
    id: "ready",
    header: "ready",
    accessor: (resource) => {
      const conditions = getValueByPath(resource, "status.conditions") as
        Array<{ type: string; status: string }> | undefined;

      if (!Array.isArray(conditions)) return "Unknown";

      const readyCondition = conditions.find((c) => c.type === "Ready");
      return readyCondition?.status === "True" ? "True" : "False";
    },
    cell: (value) => String(value ?? "-"),
  },
  {
    id: "url",
    header: "url",
    accessor: (resource) => getValueByPath(resource, "spec.url"),
    cell: (value) => {
      if (!value) return "-";
      // Truncate long URLs
      const url = String(value);
      if (url.length > 50) {
        return url.substring(0, 47) + "...";
      }
      return url;
    },
  },
  {
    id: "type",
    header: "type",
    accessor: (resource) => {
      const repoType = getValueByPath(resource, "spec.type") as
        string | undefined;
      return repoType ?? "default";
    },
    cell: (value) => String(value ?? "-"),
  },
  {
    id: "interval",
    header: "interval",
    accessor: (resource) => getValueByPath(resource, "spec.interval"),
    cell: (value) => String(value ?? "-"),
  },
  {
    id: "artifact",
    header: "lastFetched",
    accessor: (resource) =>
      getValueByPath(resource, "status.artifact.lastUpdateTime"),
    cell: (value) => {
      if (!value) return "-";
      const date = new Date(String(value));
      if (isNaN(date.getTime())) return "-";
      return date.toLocaleString();
    },
  },
];

/**
 * Columns for HelmChart list
 */
const helmChartColumns: CrdColumn[] = [
  {
    id: "ready",
    header: "ready",
    accessor: (resource) => {
      const conditions = getValueByPath(resource, "status.conditions") as
        Array<{ type: string; status: string }> | undefined;

      if (!Array.isArray(conditions)) return "Unknown";

      const readyCondition = conditions.find((c) => c.type === "Ready");
      return readyCondition?.status === "True" ? "True" : "False";
    },
    cell: (value) => String(value ?? "-"),
  },
  {
    id: "chart",
    header: "chart",
    accessor: (resource) => getValueByPath(resource, "spec.chart"),
    cell: (value) => String(value ?? "-"),
  },
  {
    id: "version",
    header: "version",
    accessor: (resource) => {
      // Try artifact version first (actual fetched version)
      const artifactRevision = getValueByPath(
        resource,
        "status.artifact.revision"
      ) as string | undefined;
      if (artifactRevision) return artifactRevision;

      // Fall back to spec version constraint
      return getValueByPath(resource, "spec.version") ?? "*";
    },
    cell: (value) => String(value ?? "-"),
  },
  {
    id: "sourceRef",
    header: "source",
    accessor: (resource) => {
      const sourceRef = getValueByPath(resource, "spec.sourceRef") as
        | {
            kind?: string;
            name: string;
          }
        | undefined;

      if (!sourceRef) return "-";
      return `${sourceRef.kind ?? "HelmRepository"}/${sourceRef.name}`;
    },
    cell: (value) => String(value ?? "-"),
  },
  {
    id: "interval",
    header: "interval",
    accessor: (resource) => getValueByPath(resource, "spec.interval"),
    cell: (value) => String(value ?? "-"),
  },
];

/**
 * Flux owns all of `helm.toolkit.fluxcd.io`, and only the Helm half of
 * `source.toolkit.fluxcd.io` — the Git and OCI sources in that group are a
 * different shape and get the generic view until somebody writes them.
 */
export const crd: CrdView = {
  matches: matchMultiple([
    ["helm.toolkit.fluxcd.io"],
    ["source.toolkit.fluxcd.io", "HelmRepository"],
    ["source.toolkit.fluxcd.io", "HelmChart"],
  ]),
  columnsFor: (kind) => {
    switch (kind.toLowerCase()) {
      case "helmrelease":
        return helmReleaseColumns;
      case "helmrepository":
        return helmRepositoryColumns;
      case "helmchart":
        return helmChartColumns;
      default:
        return helmReleaseColumns;
    }
  },
  status: fluxStatusConfig,
};
