import type {
  CustomResourceInfo,
  NamespaceInfo,
  PromSeries,
  ScrapeTarget,
  ServiceInfo,
} from "@/generated/types";
import { conditionOf, getValueByPath } from "../../kit";
import type { Tone } from "../../page-kit";
import { escapeRegex } from "../queries";

export const GROUP = "monitoring.coreos.com";
export const SERVICE_MONITORS_CRD = `servicemonitors.${GROUP}`;
export const POD_MONITORS_CRD = `podmonitors.${GROUP}`;
export const PROMETHEUSES_CRD = `prometheuses.${GROUP}`;
export const RULES_CRD = `prometheusrules.${GROUP}`;

/** A list the cluster answered, or the reason it did not. */
export type Read<T> = { ok: true; items: T[] } | { ok: false; reason: string };

/**
 * A list of one of the operator's kinds. The third answer is the one a
 * partial install produces: the kind does not exist in this cluster, which
 * is a fact about the cluster and not a failure to look.
 */
export type Kind<T> =
  | { state: "read"; items: T[] }
  | { state: "unread"; reason: string }
  | { state: "absent" };

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

/** `key=value, key2 in (a, b)`: the selector as a reader spells it. */
export function selectorWords(selector: LabelSelector | null): string {
  if (selector === null) return "";
  const parts = Object.entries(selector.matchLabels ?? {}).map(
    ([key, value]) => `${key}=${value}`
  );
  for (const e of selector.matchExpressions ?? []) {
    const values = (e.values ?? []).join(", ");
    parts.push(
      e.operator === "In"
        ? `${e.key} in (${values})`
        : e.operator === "NotIn"
          ? `${e.key} notin (${values})`
          : e.operator === "Exists"
            ? e.key
            : e.operator === "DoesNotExist"
              ? `!${e.key}`
              : `${e.key} ${e.operator} (${values})`
    );
  }
  return parts.join(", ");
}

/** Which selector is the empty one: `{}` picks everything, absent nothing. */
export function selectorIsEmpty(selector: LabelSelector | null): boolean {
  return (
    selector !== null &&
    Object.keys(selector.matchLabels ?? {}).length === 0 &&
    (selector.matchExpressions ?? []).length === 0
  );
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
 * rather than drawn as "not picked up". A refused list of Prometheus
 * objects is unknown for every monitor; a cluster without the kind at all
 * is not judged, because nothing of the operator's can pick anything up.
 */
export type PickedUp =
  | { state: "judged"; by: string[] }
  | { state: "unknown"; by: string[]; reason: string }
  | { state: "noKind" };

export function pickedUpBy(
  monitor: Monitor,
  instances: Kind<PrometheusInstance>,
  namespaces: Read<NamespaceInfo>
): PickedUp {
  if (instances.state === "absent") return { state: "noKind" };
  if (instances.state === "unread")
    return { state: "unknown", by: [], reason: instances.reason };
  const by: string[] = [];
  let unknown: string | null = null;
  for (const instance of instances.items) {
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
    if (selectorIsEmpty(scope)) {
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
    ? { state: "judged", by }
    : { state: "unknown", by, reason: unknown };
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
      targets: ScrapeTarget[];
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
  const own = targets.targets.filter((target) =>
    target.scrapePool.startsWith(prefix)
  );
  let up = 0;
  let down = 0;
  let unknown = 0;
  let lastError: string | null = null;
  let lastScrape: string | null = null;
  for (const target of own) {
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
  return {
    state: "read",
    targets: own,
    up,
    down,
    unknown,
    lastError,
    lastScrape,
  };
}

/**
 * The series behind a monitor's targets, by the labels Prometheus put on
 * them. The pool name is not a label, so `up` is asked by job and instance.
 * `null` when there is no target to ask about.
 */
export function upQuery(targets: ScrapeTarget[]): string | null {
  const jobs = [...new Set(targets.map((t) => t.labels.job).filter(Boolean))];
  const instances = [
    ...new Set(targets.map((t) => t.labels.instance).filter(Boolean)),
  ];
  if (instances.length === 0) return null;
  const alternatives = (values: string[]) =>
    values.map((v) => escapeRegex(v)).join("|");
  return jobs.length === 0
    ? `up{instance=~"${alternatives(instances)}"}`
    : `up{job=~"${alternatives(jobs)}",instance=~"${alternatives(instances)}"}`;
}

export type Beat = "up" | "down" | "none";

export interface Lane {
  instance: string;
  job: string;
  cells: Beat[];
}

/**
 * One row of cells per instance over `[from, to)`, a cell per `step` ms.
 * A cell holds the last sample that landed in it; a cell nothing landed in
 * is `none`, which the strip draws as a gap rather than as either health.
 */
export function lanesOf(
  series: PromSeries[],
  from: number,
  to: number,
  step: number
): Lane[] {
  const cells = Math.max(1, Math.round((to - from) / step));
  return series
    .map((s) => {
      const lane: Beat[] = Array.from({ length: cells }, () => "none");
      for (const point of s.points) {
        const index = Math.floor((point.t - from) / step);
        if (index < 0 || index >= cells || point.v === null) continue;
        lane[index] = point.v >= 1 ? "up" : "down";
      }
      return {
        instance: s.labels.instance ?? "",
        job: s.labels.job ?? "",
        cells: lane,
      };
    })
    .sort(
      (a, b) =>
        a.instance.localeCompare(b.instance) || a.job.localeCompare(b.job)
    );
}

/** When the current run of `down` cells began, or `null` if the last cell is not down. */
export function downSince(
  lanes: Lane[],
  from: number,
  step: number
): number | null {
  let earliest: number | null = null;
  for (const lane of lanes) {
    let index = lane.cells.length - 1;
    while (index >= 0 && lane.cells[index] === "none") index--;
    if (index < 0 || lane.cells[index] !== "down") continue;
    while (index > 0 && lane.cells[index - 1] !== "up") index--;
    const at = from + index * step;
    if (earliest === null || at < earliest) earliest = at;
  }
  return earliest;
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
  if (pickedUp.state === "judged" && pickedUp.by.length === 0)
    findings.push({ kind: "notPickedUp", severity: "err" });
  if (pickedUp.state === "unknown" && pickedUp.by.length === 0)
    findings.push({
      kind: "pickedUpUnknown",
      severity: "warn",
      reason: pickedUp.reason,
    });
  if (scrape.state === "read") {
    const total = scrape.up + scrape.down + scrape.unknown;
    const knownUnpicked =
      pickedUp.state === "judged" && pickedUp.by.length === 0;
    const selectsSomething =
      selected.kind !== "services" || selected.names.length > 0;
    if (scrape.down > 0)
      findings.push({
        kind: "targetsDown",
        severity: "err",
        down: scrape.down,
        total,
        lastError: scrape.lastError,
      });
    // Selecting something, yet Prometheus has no target in the pool: the
    // operator has not written it yet, wrote it for a different Prometheus
    // than the one connected, or nothing here can pick it up at all. Not
    // the same as down, and not raised on top of "nobody picks it up".
    else if (total === 0 && !knownUnpicked && selectsSomething)
      findings.push({ kind: "noTargets", severity: "warn" });
  }
  return findings.sort((a, b) => rank(a.severity) - rank(b.severity));
}

const rank = (severity: "err" | "warn") => (severity === "err" ? 0 : 1);

export function rowsOf(
  monitors: Monitor[],
  instances: Kind<PrometheusInstance>,
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

/** Where a row sits in the ladder. */
export type Group = "broken" | "waiting" | "scraped" | "unchecked";

export function groupOf(row: MonitorRow): Group {
  if (row.worst === "err") return "broken";
  if (row.worst === "warn") return "waiting";
  return row.scrape.state === "read" ? "scraped" : "unchecked";
}

/**
 * The hyphenated prefix at least half the names share, when it is long
 * enough to be worth hiding: a chart names every monitor after itself, and
 * a list of sixteen `kps-kube-prometheus-stack-` is a list nobody can scan.
 */
export function sharedPrefix(names: string[]): string | null {
  if (names.length < 3) return null;
  const counts = new Map<string, number>();
  for (const name of names) {
    let at = name.indexOf("-");
    while (at !== -1) {
      const prefix = name.slice(0, at + 1);
      counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
      at = name.indexOf("-", at + 1);
    }
  }
  let best: string | null = null;
  for (const [prefix, n] of counts) {
    if (n * 2 < names.length || n < 3 || prefix.length < 8) continue;
    if (best === null || prefix.length > best.length) best = prefix;
  }
  return best;
}

/**
 * The likely cause, from the words Prometheus wrote and the shape of the
 * monitor, or `null` when nothing here has a usual cause. A guess, named
 * as one, and never a substitute for the verbatim error above it.
 */
export type Hint =
  | { key: "loopback"; port: string; component: string }
  | { key: "refused"; port: string }
  | { key: "notFound"; path: string; port: string }
  | { key: "unauthorized" }
  | { key: "tls" }
  | { key: "timeout" }
  | { key: "dns" }
  | { key: "selectsNothing"; selector: string; namespace: string }
  | { key: "podPort"; port: string }
  | { key: "noEndpoints"; port: string };

const LOOPBACK_PORTS: Record<string, string> = {
  "10257": "kube-controller-manager",
  "10259": "kube-scheduler",
  "2381": "etcd",
  "10249": "kube-proxy",
};

export function hintFor(row: MonitorRow): Hint | null {
  const worst = row.findings[0];
  if (!worst) return null;
  const endpoint = row.monitor.endpoints[0];
  const port = endpoint?.port ?? "?";
  if (worst.kind === "selectsNothing")
    return {
      key: "selectsNothing",
      selector: selectorWords(row.monitor.selector),
      namespace: row.monitor.namespace,
    };
  if (worst.kind === "noTargets")
    return row.monitor.kind === "PodMonitor"
      ? { key: "podPort", port }
      : { key: "noEndpoints", port };
  if (worst.kind !== "targetsDown" || !worst.lastError) return null;
  const said = worst.lastError;
  const dialPort = /:(\d+)\/[^ ]*": dial tcp/.exec(said)?.[1] ?? null;
  if (/connection refused/.test(said)) {
    const component = dialPort ? LOOPBACK_PORTS[dialPort] : undefined;
    return component
      ? { key: "loopback", port: dialPort!, component }
      : { key: "refused", port: dialPort ?? port };
  }
  if (/HTTP status 404/.test(said))
    return { key: "notFound", path: endpoint?.path ?? "/metrics", port };
  if (/HTTP status 40[13]/.test(said)) return { key: "unauthorized" };
  if (/x509|certificate|tls:/i.test(said)) return { key: "tls" };
  if (/deadline exceeded|timeout/i.test(said)) return { key: "timeout" };
  if (/no such host/.test(said)) return { key: "dns" };
  return null;
}
