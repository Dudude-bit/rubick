import type {
  AlertInstance,
  AlertRule,
  CustomResourceInfo,
  NamespaceInfo,
} from "@/generated/types";
import { getValueByPath } from "../../kit";
import type { AlertAbout } from "../../registry";
import {
  RULES_CRD,
  selectedBy,
  type Kind,
  type PickedUp,
  type PrometheusInstance,
  type Read,
} from "../monitors/model";

export { RULES_CRD };
export type { AlertAbout };

/** One `alert:` rule as the PrometheusRule spells it. */
export interface RuleSpec {
  group: string;
  alert: string;
  expr: string;
  for: string | null;
  labels: Record<string, string>;
  annotations: Record<string, string>;
}

export interface RuleObject {
  name: string;
  namespace: string;
  uid: string;
  labels: Record<string, string>;
  rules: RuleSpec[];
  /** `record:` rules, counted and not judged: they fire nothing. */
  recording: number;
}

const text = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;

const record = (value: unknown): Record<string, string> => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>))
    if (typeof entry === "string") out[key] = entry;
  return out;
};

export function readRule(resource: CustomResourceInfo): RuleObject {
  const groups = getValueByPath(resource, "spec.groups");
  const rules: RuleSpec[] = [];
  let recording = 0;
  for (const group of Array.isArray(groups) ? groups : []) {
    const raw = (group ?? {}) as Record<string, unknown>;
    const groupName = text(raw.name) ?? "";
    for (const rule of Array.isArray(raw.rules) ? raw.rules : []) {
      const entry = (rule ?? {}) as Record<string, unknown>;
      const alert = text(entry.alert);
      if (alert === null) {
        if (text(entry.record) !== null) recording++;
        continue;
      }
      rules.push({
        group: groupName,
        alert,
        expr:
          typeof entry.expr === "string"
            ? entry.expr
            : String(entry.expr ?? ""),
        for: text(entry.for),
        labels: record(entry.labels),
        annotations: record(entry.annotations),
      });
    }
  }
  return {
    name: resource.name,
    namespace: resource.namespace ?? "",
    uid: resource.uid,
    labels: resource.labels,
    rules,
    recording,
  };
}

export function rulePickedUpBy(
  rule: RuleObject,
  instances: Kind<PrometheusInstance>,
  namespaces: Read<NamespaceInfo>
): PickedUp {
  return selectedBy(rule, instances, namespaces, (instance) => [
    instance.ruleSelector,
    instance.ruleNamespaceSelector,
  ]);
}

/** What the connected Prometheus said about its rules. */
export type RulesRead =
  | { state: "notConnected" }
  | { state: "unanswered"; reason: string }
  | { state: "read"; rules: AlertRule[] };

/**
 * The rule files the operator writes for an object are named after it:
 * `<namespace>-<name>.yaml`, or `<namespace>-<name>-<uid>.yaml` on the
 * releases that append the uid. Either spelling is the object's.
 */
export function ownsFile(rule: RuleObject, file: string): boolean {
  const base = file.slice(file.lastIndexOf("/") + 1);
  const stem = `${rule.namespace}-${rule.name}`;
  return base === `${stem}.yaml` || base === `${stem}-${rule.uid}.yaml`;
}

/** One rule of the object as Prometheus has it, or not at all. */
export interface RuleState {
  spec: RuleSpec;
  loaded: AlertRule | null;
}

export type Loaded =
  | { state: "notConnected" }
  | { state: "unanswered"; reason: string }
  | { state: "read"; rules: RuleState[]; files: string[] };

export function loadedOf(rule: RuleObject, read: RulesRead): Loaded {
  if (read.state !== "read") return read;
  const own = read.rules.filter((entry) => ownsFile(rule, entry.file));
  const files = [...new Set(own.map((entry) => entry.file))];
  return {
    state: "read",
    files,
    rules: rule.rules.map((spec) => ({
      spec,
      loaded:
        own.find(
          (entry) => entry.group === spec.group && entry.name === spec.alert
        ) ?? null,
    })),
  };
}

export type RuleFinding =
  | { kind: "notPickedUp"; severity: "err" }
  | { kind: "pickedUpUnknown"; severity: "warn"; reason: string }
  | { kind: "notLoaded"; severity: "err" }
  | { kind: "partlyLoaded"; severity: "err"; missing: string[] }
  | { kind: "evalError"; severity: "err"; rule: string; lastError: string }
  /** Loaded, and Prometheus has not evaluated it once: health `unknown`. */
  | { kind: "notEvaluated"; severity: "warn"; rule: string }
  | { kind: "firing"; severity: "err"; alerts: number; rules: number }
  | { kind: "pending"; severity: "warn"; alerts: number; rules: number };

export type RuleGroup = "firing" | "pending" | "broken" | "quiet" | "unchecked";

export interface RuleRow {
  object: RuleObject;
  pickedUp: PickedUp;
  loaded: Loaded;
  findings: RuleFinding[];
  group: RuleGroup;
}

/** Firing first: it is what the reader came for, and a fault beside it is why the rest is silent. */
const RANK: Record<RuleFinding["kind"], number> = {
  firing: 0,
  notPickedUp: 1,
  notLoaded: 1,
  partlyLoaded: 1,
  evalError: 1,
  notEvaluated: 2,
  pending: 2,
  pickedUpUnknown: 3,
};

export function findingsOf(
  object: RuleObject,
  pickedUp: PickedUp,
  loaded: Loaded
): RuleFinding[] {
  const findings: RuleFinding[] = [];
  if (pickedUp.state === "judged" && pickedUp.by.length === 0)
    findings.push({ kind: "notPickedUp", severity: "err" });
  if (pickedUp.state === "unknown" && pickedUp.by.length === 0)
    findings.push({
      kind: "pickedUpUnknown",
      severity: "warn",
      reason: pickedUp.reason,
    });
  if (loaded.state === "read") {
    const knownUnpicked =
      pickedUp.state === "judged" && pickedUp.by.length === 0;
    // Whether anything picks this up is the question "has it been loaded"
    // depends on: with the pick-up unknown, "picked up, but not loaded" is
    // a claim about a Prometheus nobody identified.
    const pickUpUnknown = pickedUp.state !== "judged";
    const missing = loaded.rules
      .filter((r) => r.loaded === null)
      .map((r) => r.spec.alert);
    // Not loaded while nothing is known to pick it up is the same fact
    // said twice; the pick-up finding already names it.
    if (
      loaded.files.length === 0 &&
      object.rules.length > 0 &&
      !knownUnpicked &&
      !pickUpUnknown
    )
      findings.push({ kind: "notLoaded", severity: "err" });
    else if (missing.length > 0 && loaded.files.length > 0)
      findings.push({ kind: "partlyLoaded", severity: "err", missing });
    for (const { spec, loaded: entry } of loaded.rules) {
      // Prometheus writes three healths and the app read one. A rule it has
      // loaded and never evaluated answers `unknown`, which fell through to
      // the green "loaded and evaluating" — a claim about a rule that has
      // never run.
      if (entry && entry.health === "unknown")
        findings.push({
          kind: "notEvaluated",
          severity: "warn",
          rule: spec.alert,
        });
      if (entry && entry.health === "err")
        findings.push({
          kind: "evalError",
          severity: "err",
          rule: spec.alert,
          lastError: entry.lastError,
        });
    }
    const firing = loaded.rules.filter(
      (r) => r.loaded !== null && r.loaded.state === "firing"
    );
    const pending = loaded.rules.filter(
      (r) => r.loaded !== null && r.loaded.state === "pending"
    );
    const count = (rows: RuleState[], state: string) =>
      rows.reduce(
        (n, r) =>
          n + (r.loaded?.alerts.filter((a) => a.state === state).length ?? 0),
        0
      );
    if (firing.length > 0)
      findings.push({
        kind: "firing",
        severity: "err",
        alerts: count(firing, "firing"),
        rules: firing.length,
      });
    if (pending.length > 0)
      findings.push({
        kind: "pending",
        severity: "warn",
        alerts: count(pending, "pending"),
        rules: pending.length,
      });
  }
  return findings.sort((a, b) => RANK[a.kind] - RANK[b.kind]);
}

/**
 * Where a row sits: something firing outranks a configuration fault, since
 * a firing alert is what the reader came to see, and a fault is what stops
 * one from ever firing.
 */
export function groupOf(findings: RuleFinding[], loaded: Loaded): RuleGroup {
  if (findings.some((f) => f.kind === "firing")) return "firing";
  if (
    findings.some((f) =>
      ["notPickedUp", "notLoaded", "partlyLoaded", "evalError"].includes(f.kind)
    )
  )
    return "broken";
  if (findings.some((f) => f.kind === "pending")) return "pending";
  // A verdict nobody could reach is not a quiet one. `pickedUpUnknown` and
  // `notEvaluated` were in no branch at all, so they were filed under Quiet
  // in green with the word "unknown" printed beside a check mark.
  if (
    findings.some((f) => ["pickedUpUnknown", "notEvaluated"].includes(f.kind))
  )
    return "unchecked";
  return loaded.state === "read" ? "quiet" : "unchecked";
}

export function rowsOf(
  objects: RuleObject[],
  instances: Kind<PrometheusInstance>,
  namespaces: Read<NamespaceInfo>,
  read: RulesRead
): RuleRow[] {
  const order: Record<RuleGroup, number> = {
    firing: 0,
    broken: 1,
    pending: 2,
    quiet: 3,
    unchecked: 3,
  };
  return objects
    .map((object): RuleRow => {
      const pickedUp = rulePickedUpBy(object, instances, namespaces);
      const loaded = loadedOf(object, read);
      const findings = findingsOf(object, pickedUp, loaded);
      return {
        object,
        pickedUp,
        loaded,
        findings,
        group: groupOf(findings, loaded),
      };
    })
    .sort(
      (a, b) =>
        order[a.group] - order[b.group] ||
        a.object.namespace.localeCompare(b.object.namespace) ||
        a.object.name.localeCompare(b.object.name)
    );
}

/** The label an alert names an object of `kind` by, as kube-state-metrics writes it. */
export const OBJECT_LABEL: Record<string, string> = {
  Pod: "pod",
  Deployment: "deployment",
  StatefulSet: "statefulset",
  DaemonSet: "daemonset",
  ReplicaSet: "replicaset",
  Job: "job_name",
  CronJob: "cronjob",
  Node: "node",
  Service: "service",
  PersistentVolumeClaim: "persistentvolumeclaim",
  HorizontalPodAutoscaler: "horizontalpodautoscaler",
  Namespace: "namespace",
};

/** The pods a workload runs, by the name pattern its controller stamps on them. */
function podsOf(kind: string, name: string): RegExp | null {
  const safe = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  switch (kind) {
    case "Deployment":
      return new RegExp(`^${safe}-[a-z0-9]+-[a-z0-9]{5}$`);
    case "StatefulSet":
      return new RegExp(`^${safe}-\\d+$`);
    case "DaemonSet":
    case "ReplicaSet":
    case "Job":
      return new RegExp(`^${safe}-[a-z0-9]{5}$`);
    default:
      return null;
  }
}

/**
 * The active alerts that name this object, from the label kube-state-metrics
 * gives its kind, and for a workload also from the pods it runs. Named by
 * the label that matched, so a guess at a pod's owner is visible as one.
 */
export function alertsAbout(
  rules: AlertRule[],
  object: { kind: string; name: string; namespace: string | null }
): AlertAbout[] {
  const label = OBJECT_LABEL[object.kind];
  const pods = podsOf(object.kind, object.name);
  const out: AlertAbout[] = [];
  const names = (
    rule: AlertRule,
    alert: AlertInstance,
    via: AlertAbout["via"]
  ) =>
    out.push({
      rule: rule.name,
      state: alert.state,
      activeAt: alert.activeAt,
      severity: alert.labels.severity ?? rule.labels.severity ?? null,
      summary:
        alert.annotations.summary ??
        alert.annotations.message ??
        alert.annotations.description ??
        null,
      via,
    });
  for (const rule of rules) {
    for (const alert of rule.alerts) {
      if (alert.state !== "firing" && alert.state !== "pending") continue;
      if (
        object.namespace !== null &&
        object.kind !== "Node" &&
        alert.labels.namespace !== undefined &&
        alert.labels.namespace !== object.namespace
      )
        continue;
      if (label && alert.labels[label] === object.name) {
        names(rule, alert, { label, value: object.name });
        continue;
      }
      const pod = alert.labels.pod;
      if (pods && pod !== undefined && pods.test(pod))
        names(rule, alert, { label: "pod", value: pod });
    }
  }
  return out;
}
