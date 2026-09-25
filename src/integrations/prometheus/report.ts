/**
 * What the Prometheus Operator's own kinds say about one object, reusing
 * `readMonitor` and `readPrometheus`, the same readers the Monitors tab
 * walks, against a `CustomResourceInfo` built from the bare `spec`/`status`
 * `object.report` hands over.
 */

import { Radar } from "lucide-react";

import type { T } from "@/i18n/useT";
import type { CustomResourceInfo } from "@/generated/types";
import { iconSvg } from "@/lib/icon-svg";
import type { ReportSection, ReportValue } from "@/lib/report";
import {
  GROUP,
  readMonitor,
  readPrometheus,
  selectorWords,
  type MonitorKind,
} from "./monitors/model";

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

function namespacesValue(monitor: ReturnType<typeof readMonitor>): ReportValue {
  if (monitor.namespaceSelector?.any) {
    return {
      text: monitor.namespaceSelector.any ? "*" : monitor.namespace,
      mono: true,
    };
  }
  const names = monitor.namespaceSelector?.matchNames ?? [];
  return {
    text: names.length > 0 ? names.join(", ") : monitor.namespace,
    mono: true,
  };
}

function monitorSections(
  object: {
    kind: MonitorKind;
    namespace: string | null;
    name: string;
    spec: unknown;
    status: unknown;
  },
  t: T
): ReportSection[] {
  const monitor = readMonitor(fakeResource(object), object.kind);
  const facts: ReportSection = {
    id: `prom-${object.kind.toLowerCase()}-selectors`,
    title: object.kind,
    icon: iconSvg(Radar),
    body: {
      type: "facts",
      rows: [
        {
          label: t("share", "promSelector"),
          values: [
            monitor.selector
              ? { text: selectorWords(monitor.selector) || "{}", mono: true }
              : { text: t("empty", "none"), quiet: true },
          ],
        },
        {
          label: t("share", "promNamespaces"),
          values: [namespacesValue(monitor)],
        },
      ],
    },
  };
  const endpoints: ReportSection = {
    id: `prom-${object.kind.toLowerCase()}-endpoints`,
    title: t("share", "promEndpoints"),
    icon: iconSvg(Radar),
    count: monitor.endpoints.length,
    body: {
      type: "table",
      columns: [
        t("columns", "port"),
        t("share", "promPath"),
        t("share", "fluxInterval"),
      ],
      rows: monitor.endpoints.map((endpoint) => ({
        cells: [
          { text: endpoint.port ?? "-", mono: true },
          { text: endpoint.path, mono: true },
          { text: endpoint.interval ?? "-" },
        ],
      })),
      more: null,
    },
  };
  return [facts, endpoints];
}

function prometheusSection(
  spec: unknown,
  status: unknown,
  t: T
): ReportSection {
  const instance = readPrometheus(
    fakeResource({
      kind: "Prometheus",
      namespace: null,
      name: "",
      spec,
      status,
    })
  );
  const rows: { label: string; values: ReportValue[] }[] = [
    {
      label: t("columns", "replicas"),
      values: [
        {
          text: `${instance.available ?? "?"}/${instance.replicas ?? 1}`,
          role:
            instance.available !== null &&
            instance.available === instance.replicas
              ? "ok"
              : "warn",
        },
      ],
    },
  ];
  if (instance.version) {
    rows.push({
      label: t("share", "promVersion"),
      values: [{ text: instance.version, mono: true }],
    });
  }
  if (instance.retention) {
    rows.push({
      label: t("share", "promRetention"),
      values: [{ text: instance.retention, mono: true }],
    });
  }
  rows.push({
    label: t("share", "promServiceMonitorSelector"),
    values: [
      {
        text: instance.serviceMonitorSelector
          ? selectorWords(instance.serviceMonitorSelector) || "{}"
          : t("empty", "none"),
        mono: true,
      },
    ],
  });
  rows.push({
    label: t("share", "promPodMonitorSelector"),
    values: [
      {
        text: instance.podMonitorSelector
          ? selectorWords(instance.podMonitorSelector) || "{}"
          : t("empty", "none"),
        mono: true,
      },
    ],
  });
  return {
    id: "prom-instance",
    title: "Prometheus",
    icon: iconSvg(Radar),
    body: { type: "facts", rows },
  };
}

interface RuleGroup {
  name?: string;
  rules?: Array<{
    alert?: string;
    record?: string;
    expr?: string;
    for?: string;
  }>;
}

function ruleSection(spec: unknown, t: T): ReportSection {
  const groups = ((spec ?? {}) as { groups?: RuleGroup[] }).groups ?? [];
  const total = groups.reduce(
    (sum, group) => sum + (group.rules?.length ?? 0),
    0
  );
  return {
    id: "prom-rule",
    title: "PrometheusRule",
    icon: iconSvg(Radar),
    count: total,
    body: {
      type: "table",
      columns: [
        t("share", "promGroup"),
        t("share", "promRule"),
        t("share", "promExpr"),
      ],
      rows: groups.flatMap((group) =>
        (group.rules ?? []).map((rule) => ({
          cells: [
            { text: group.name ?? "-" },
            { text: rule.alert ?? rule.record ?? "-", mono: true },
            { text: rule.expr ?? "-", mono: true },
          ],
        }))
      ),
      more: null,
    },
  };
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
    case "ServiceMonitor":
    case "PodMonitor":
      return monitorSections({ ...object, kind: object.kind }, t);
    case "Prometheus":
      return [prometheusSection(object.spec, object.status, t)];
    case "PrometheusRule":
      return [ruleSection(object.spec, t)];
    default:
      return null;
  }
}
