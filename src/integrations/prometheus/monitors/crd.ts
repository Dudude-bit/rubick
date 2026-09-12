import type { CrdColumn } from "../../kit";
import { conditionStatus, getValueByPath, matchByGroup } from "../../kit";
import type { CrdView } from "../../registry";
import { GROUP } from "./model";

function selectorText(value: unknown): string {
  if (typeof value !== "object" || value === null) return "-";
  const labels = (value as { matchLabels?: Record<string, string> })
    .matchLabels;
  const pairs = Object.entries(labels ?? {}).map(([k, v]) => `${k}=${v}`);
  const expressions = (value as { matchExpressions?: unknown[] })
    .matchExpressions;
  if (Array.isArray(expressions) && expressions.length > 0)
    pairs.push(`+${expressions.length} expr`);
  return pairs.length > 0 ? pairs.join(", ") : "{}";
}

const monitorColumns = (endpointsPath: string): CrdColumn[] => [
  {
    id: "selector",
    header: "selector",
    accessor: (resource) =>
      selectorText(getValueByPath(resource, "spec.selector")),
    cell: (value) => String(value ?? "-"),
  },
  {
    id: "endpoints",
    header: "endpoints",
    accessor: (resource) => {
      const endpoints = getValueByPath(resource, endpointsPath);
      return Array.isArray(endpoints) ? endpoints.length : 0;
    },
    cell: (value) => String(value ?? 0),
  },
];

const prometheusColumns: CrdColumn[] = [
  {
    id: "replicas",
    header: "replicas",
    accessor: (resource) => {
      const available = getValueByPath(resource, "status.availableReplicas");
      const wanted = getValueByPath(resource, "spec.replicas") ?? 1;
      return `${typeof available === "number" ? available : "?"}/${String(wanted)}`;
    },
    cell: (value) => String(value ?? "-"),
  },
  {
    id: "version",
    header: "version",
    accessor: (resource) => getValueByPath(resource, "spec.version"),
    cell: (value) => String(value ?? "-"),
  },
  {
    id: "retention",
    header: "retention",
    accessor: (resource) => getValueByPath(resource, "spec.retention"),
    cell: (value) => String(value ?? "-"),
  },
];

const ruleColumns: CrdColumn[] = [
  {
    id: "groups",
    header: "groups",
    accessor: (resource) => {
      const groups = getValueByPath(resource, "spec.groups");
      return Array.isArray(groups) ? groups.length : 0;
    },
    cell: (value) => String(value ?? 0),
  },
];

export const crd: CrdView = {
  matches: matchByGroup(GROUP),
  columnsFor: (kind) => {
    switch (kind) {
      case "ServiceMonitor":
        return monitorColumns("spec.endpoints");
      case "PodMonitor":
        return monitorColumns("spec.podMetricsEndpoints");
      case "Prometheus":
        return prometheusColumns;
      case "PrometheusRule":
        return ruleColumns;
      default:
        return [];
    }
  },
  // Only a Prometheus carries a condition; a monitor is configuration and
  // has no state of its own to colour.
  status: conditionStatus("Available"),
};
