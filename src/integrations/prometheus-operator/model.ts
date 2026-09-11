import type {
  CustomResourceInfo,
  NamespaceInfo,
  ScrapeTarget,
  ServiceInfo,
} from "@/generated/types";
import { conditionOf, getValueByPath } from "../kit";
import type { Tone } from "../page-kit";
import type { Read } from "./data";

export const GROUP = "monitoring.coreos.com";
export const SERVICE_MONITORS_CRD = `servicemonitors.${GROUP}`;
export const POD_MONITORS_CRD = `podmonitors.${GROUP}`;
export const PROMETHEUSES_CRD = `prometheuses.${GROUP}`;
export const RULES_CRD = `prometheusrules.${GROUP}`;

export type MonitorKind = "ServiceMonitor" | "PodMonitor";

/** `metav1.LabelSelector`, as the operator's CRDs carry it. */
export interface LabelSelector {
  matchLabels?: Record<string, string>;
  matchExpressions?: Array<{
    key: string;
    operator: string;
    values?: string[];
  }>;
}

/**
 * The operator's own namespace selector on a monitor: `any` reaches every
 * namespace, `matchNames` the listed ones, and an absent or empty selector
 * the monitor's own namespace. Not a label selector, unlike the one on a
 * Prometheus.
 */
export interface NamespaceSelector {
  any?: boolean;
  matchNames?: string[];
}

export interface Endpoint {
  port: string | null;
  path: string;
  interval: string | null;
}

export interface Monitor {
  kind: MonitorKind;
  name: string;
  namespace: string;
  uid: string;
  labels: Record<string, string>;
  selector: LabelSelector | null;
  namespaceSelector: NamespaceSelector | null;
  endpoints: Endpoint[];
}

export interface Condition {
  status: string | null;
  reason: string | null;
  message: string | null;
}

export interface PrometheusInstance {
  name: string;
  namespace: string;
  uid: string;
  replicas: number | null;
  available: number | null;
  version: string | null;
  retention: string | null;
  serviceMonitorSelector: LabelSelector | null;
  serviceMonitorNamespaceSelector: LabelSelector | null;
  podMonitorSelector: LabelSelector | null;
  podMonitorNamespaceSelector: LabelSelector | null;
  availableCondition: Condition | null;
  reconciled: Condition | null;
}

function record(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>))
    if (typeof entry === "string") out[key] = entry;
  return out;
}

function labelSelector(value: unknown): LabelSelector | null {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return null;
  const raw = value as Record<string, unknown>;
  const expressions = Array.isArray(raw.matchExpressions)
    ? raw.matchExpressions.filter(
        (e): e is { key: string; operator: string; values?: string[] } =>
          typeof e === "object" &&
          e !== null &&
          typeof (e as { key?: unknown }).key === "string" &&
          typeof (e as { operator?: unknown }).operator === "string"
      )
    : undefined;
  return {
    ...(raw.matchLabels !== undefined
      ? { matchLabels: record(raw.matchLabels) }
      : {}),
    ...(expressions !== undefined ? { matchExpressions: expressions } : {}),
  };
}

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Whether `labels` satisfy `selector`.
 *
 * A missing selector matches nothing and an empty one matches everything.
 * That asymmetry is the operator's, not ours: `serviceMonitorSelector: {}`
 * on a Prometheus means "every monitor" and leaving it out means "none",
 * and a page that read both as "all" would say a Prometheus scrapes what it
 * has been told to ignore.
 */
export function selectorMatches(
  selector: LabelSelector | null | undefined,
  labels: Record<string, string>
): boolean {
  if (selector === null || selector === undefined) return false;
  for (const [key, value] of Object.entries(selector.matchLabels ?? {})) {
    if (labels[key] !== value) return false;
  }
  for (const expression of selector.matchExpressions ?? []) {
    const actual = labels[expression.key];
    const values = expression.values ?? [];
    switch (expression.operator) {
      case "In":
        if (actual === undefined || !values.includes(actual)) return false;
        break;
      case "NotIn":
        if (actual !== undefined && values.includes(actual)) return false;
        break;
      case "Exists":
        if (actual === undefined) return false;
        break;
      case "DoesNotExist":
        if (actual !== undefined) return false;
        break;
      default:
        return false;
    }
  }
  return true;
}

/** Whether a monitor in `own` reaches objects in `namespace`. */
export function monitorReaches(
  own: string,
  selector: NamespaceSelector | null,
  namespace: string
): boolean {
  if (selector?.any) return true;
  const names = selector?.matchNames ?? [];
  if (names.length > 0) return names.includes(namespace);
  return namespace === own;
}

export function readMonitor(
  resource: CustomResourceInfo,
  kind: MonitorKind
): Monitor {
  const endpointsPath =
    kind === "ServiceMonitor" ? "spec.endpoints" : "spec.podMetricsEndpoints";
  const rawEndpoints = getValueByPath(resource, endpointsPath);
  const endpoints: Endpoint[] = Array.isArray(rawEndpoints)
    ? rawEndpoints.map((entry) => {
        const raw = (entry ?? {}) as Record<string, unknown>;
        const port =
          text(raw.port) ??
          (raw.portNumber !== undefined ? String(raw.portNumber) : null) ??
          (raw.targetPort !== undefined ? String(raw.targetPort) : null);
        return {
          port,
          path: text(raw.path) ?? "/metrics",
          interval: text(raw.interval),
        };
      })
    : [];
  const rawNamespaces = getValueByPath(resource, "spec.namespaceSelector");
  const namespaceSelector: NamespaceSelector | null =
    typeof rawNamespaces === "object" && rawNamespaces !== null
      ? {
          any: (rawNamespaces as { any?: unknown }).any === true,
          matchNames: Array.isArray(
            (rawNamespaces as { matchNames?: unknown }).matchNames
          )
            ? (rawNamespaces as { matchNames: unknown[] }).matchNames.filter(
                (n): n is string => typeof n === "string"
              )
            : [],
        }
      : null;
  return {
    kind,
    name: resource.name,
    namespace: resource.namespace ?? "",
    uid: resource.uid,
    labels: resource.labels,
    selector: labelSelector(getValueByPath(resource, "spec.selector")),
    namespaceSelector,
    endpoints,
  };
}

export function readPrometheus(
  resource: CustomResourceInfo
): PrometheusInstance {
  const condition = (type: string): Condition | null => {
    const found = conditionOf(resource, type);
    return found
      ? {
          status: found.status ?? null,
          reason: found.reason ?? null,
          message: found.message ?? null,
        }
      : null;
  };
  return {
    name: resource.name,
    namespace: resource.namespace ?? "",
    uid: resource.uid,
    replicas: count(getValueByPath(resource, "spec.replicas")) ?? 1,
    available: count(getValueByPath(resource, "status.availableReplicas")),
    version:
      text(getValueByPath(resource, "spec.version")) ??
      text(getValueByPath(resource, "spec.image")),
    retention: text(getValueByPath(resource, "spec.retention")),
    serviceMonitorSelector: labelSelector(
      getValueByPath(resource, "spec.serviceMonitorSelector")
    ),
    serviceMonitorNamespaceSelector: labelSelector(
      getValueByPath(resource, "spec.serviceMonitorNamespaceSelector")
    ),
    podMonitorSelector: labelSelector(
      getValueByPath(resource, "spec.podMonitorSelector")
    ),
    podMonitorNamespaceSelector: labelSelector(
      getValueByPath(resource, "spec.podMonitorNamespaceSelector")
    ),
    availableCondition: condition("Available"),
    reconciled: condition("Reconciled"),
  };
}

/** What a monitor selects, or why that could not be counted. */
export type Selected =
  | { kind: "services"; names: string[] }
  /** Pods are not listed cluster-wide for this; the count is not claimed. */
  | { kind: "notCounted" }
  | { kind: "unread"; reason: string };

export function selectedServices(
  monitor: Monitor,
  services: Read<ServiceInfo>
): Selected {
  if (monitor.kind === "PodMonitor") return { kind: "notCounted" };
  if (!services.ok) return { kind: "unread", reason: services.reason };
  return {
    kind: "services",
    names: services.items
      .filter(
        (service) =>
          monitorReaches(
            monitor.namespace,
            monitor.namespaceSelector,
            service.namespace
          ) && selectorMatches(monitor.selector, service.labels)
      )
      .map((service) => `${service.namespace}/${service.name}`),
  };
}

/**
 * Which Prometheus instances pick a monitor up.
 *
 * Two selectors on the Prometheus decide it: one over the monitor's labels
 * and one over its namespace's labels. The second needs the namespaces
 * read; when they were not, the answer is unknown for every Prometheus
 * whose namespace selector is neither absent nor empty, and it is said so
 * rather than drawn as "not picked up".
 */
export type PickedUp =
  | { known: true; by: string[] }
  | { known: false; by: string[]; reason: string };

export function pickedUpBy(
  monitor: Monitor,
  instances: PrometheusInstance[],
  namespaces: Read<NamespaceInfo>
): PickedUp {
  const by: string[] = [];
  let unknown: string | null = null;
  for (const instance of instances) {
    const objects =
      monitor.kind === "ServiceMonitor"
        ? instance.serviceMonitorSelector
        : instance.podMonitorSelector;
    if (!selectorMatches(objects, monitor.labels)) continue;
    const scope =
      monitor.kind === "ServiceMonitor"
        ? instance.serviceMonitorNamespaceSelector
        : instance.podMonitorNamespaceSelector;
    if (scope === null) {
      if (monitor.namespace === instance.namespace) by.push(instance.name);
      continue;
    }
    const wide =
      Object.keys(scope.matchLabels ?? {}).length === 0 &&
      (scope.matchExpressions ?? []).length === 0;
    if (wide) {
      by.push(instance.name);
      continue;
    }
    if (!namespaces.ok) {
      unknown = namespaces.reason;
      continue;
    }
    const labels =
      namespaces.items.find((ns) => ns.name === monitor.namespace)?.labels ??
      {};
    if (selectorMatches(scope, labels)) by.push(instance.name);
  }
  return unknown === null
    ? { known: true, by }
    : { known: false, by, reason: unknown };
}

/** What the connected Prometheus said about its targets. */
export type TargetsRead =
  | { state: "notConnected" }
  | { state: "unanswered"; reason: string }
  | { state: "read"; targets: ScrapeTarget[] };

export type Scrape =
  | { state: "notConnected" }
  | { state: "unanswered"; reason: string }
  | {
      state: "read";
      up: number;
      down: number;
      unknown: number;
      lastError: string | null;
      lastScrape: string | null;
    };

/** The scrape pools the operator writes for a monitor: `serviceMonitor/<ns>/<name>/<i>`. */
export function poolPrefix(monitor: Monitor): string {
  const head =
    monitor.kind === "ServiceMonitor" ? "serviceMonitor" : "podMonitor";
  return `${head}/${monitor.namespace}/${monitor.name}/`;
}

export function scrapeOf(monitor: Monitor, targets: TargetsRead): Scrape {
  if (targets.state !== "read") return targets;
  const prefix = poolPrefix(monitor);
  let up = 0;
  let down = 0;
  let unknown = 0;
  let lastError: string | null = null;
  let lastScrape: string | null = null;
  for (const target of targets.targets) {
    if (!target.scrapePool.startsWith(prefix)) continue;
    if (target.health === "up") up++;
    else if (target.health === "down") down++;
    else unknown++;
    if (target.lastError !== "" && lastError === null)
      lastError = target.lastError;
    if (
      target.lastScrape &&
      (lastScrape === null || target.lastScrape > lastScrape)
    )
      lastScrape = target.lastScrape;
  }
  return { state: "read", up, down, unknown, lastError, lastScrape };
}

export type MonitorFinding =
  | { kind: "selectsNothing"; severity: "err" }
  | { kind: "selectionUnread"; severity: "warn"; reason: string }
  | { kind: "notPickedUp"; severity: "err" }
  | { kind: "pickedUpUnknown"; severity: "warn"; reason: string }
  | {
      kind: "targetsDown";
      severity: "err";
      down: number;
      total: number;
      lastError: string | null;
    }
  | { kind: "noTargets"; severity: "warn" };

export interface MonitorRow {
  monitor: Monitor;
  selected: Selected;
  pickedUp: PickedUp;
  scrape: Scrape;
  findings: MonitorFinding[];
  worst: Exclude<Tone, "ok"> | null;
}

function findingsOf(
  selected: Selected,
  pickedUp: PickedUp,
  scrape: Scrape
): MonitorFinding[] {
  const findings: MonitorFinding[] = [];
  if (selected.kind === "services" && selected.names.length === 0)
    findings.push({ kind: "selectsNothing", severity: "err" });
  if (selected.kind === "unread")
    findings.push({
      kind: "selectionUnread",
      severity: "warn",
      reason: selected.reason,
    });
  if (pickedUp.by.length === 0) {
    if (pickedUp.known) findings.push({ kind: "notPickedUp", severity: "err" });
    else
      findings.push({
        kind: "pickedUpUnknown",
        severity: "warn",
        reason: pickedUp.reason,
      });
  }
  if (scrape.state === "read") {
    const total = scrape.up + scrape.down + scrape.unknown;
    if (scrape.down > 0)
      findings.push({
        kind: "targetsDown",
        severity: "err",
        down: scrape.down,
        total,
        lastError: scrape.lastError,
      });
    // Picked up and selecting something, yet Prometheus has no target in
    // the pool: the operator has not written it yet, or wrote it for a
    // different Prometheus than the one connected. Not the same as down.
    else if (
      total === 0 &&
      pickedUp.by.length > 0 &&
      selected.kind !== "services"
    )
      findings.push({ kind: "noTargets", severity: "warn" });
    else if (
      total === 0 &&
      pickedUp.by.length > 0 &&
      selected.kind === "services" &&
      selected.names.length > 0
    )
      findings.push({ kind: "noTargets", severity: "warn" });
  }
  return findings;
}

export function rowsOf(
  monitors: Monitor[],
  instances: PrometheusInstance[],
  services: Read<ServiceInfo>,
  namespaces: Read<NamespaceInfo>,
  targets: TargetsRead
): MonitorRow[] {
  const rows = monitors.map((monitor): MonitorRow => {
    const selected = selectedServices(monitor, services);
    const pickedUp = pickedUpBy(monitor, instances, namespaces);
    const scrape = scrapeOf(monitor, targets);
    const findings = findingsOf(selected, pickedUp, scrape);
    const worst = findings.some((f) => f.severity === "err")
      ? "err"
      : findings.some((f) => f.severity === "warn")
        ? "warn"
        : null;
    return { monitor, selected, pickedUp, scrape, findings, worst };
  });
  const rank = (row: MonitorRow) =>
    row.worst === "err" ? 0 : row.worst === "warn" ? 1 : 2;
  return rows.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      a.monitor.namespace.localeCompare(b.monitor.namespace) ||
      a.monitor.name.localeCompare(b.monitor.name)
  );
}
