/**
 * Reading an alert somebody was woken by, and turning it into an object.
 *
 * Not an integration. Nothing here polls, subscribes or sends: a person
 * pastes the message their phone showed them, and this reads it. What it
 * recognises it must be able to point at, so every field carries the line it
 * came from, and a field recognised by shape says so instead of borrowing a
 * key it never had.
 *
 * The grammar is not guessed. Alertmanager's plain-text body is `Labels:`,
 * ` - name = value` lines, `Annotations:` and `Source:`, and email, Telegram,
 * OpsGenie, MS Teams and Mattermost all render that same body. Grafana's is
 * the same shape with `Value:`, `Silence:`, `Dashboard:` and `Panel:` added,
 * so it is a superset rather than a rival. PagerDuty and Slack are wrappers
 * whose own text carries an incident number and a service name, with the
 * Kubernetes identity in the description they were handed. So this strips the
 * chrome and reads what is inside, rather than pretending to know four
 * formats.
 */

/** Where a recognised value came from, so a wrong read is visible before it opens. */
export type Provenance =
  /** A `name = value` line, the only unambiguous case. */
  | { how: "key"; key: string }
  /** The alert's own name said which kind it is about. */
  | { how: "alertName" }
  /** The `Source:` URL's host, where no label named the cluster. */
  | { how: "sourceHost"; host: string }
  /** No key anywhere; recognised by what the value looks like. */
  | { how: "shape"; says: "podName" };

export interface Named<T> {
  value: T;
  from: Provenance;
}

export interface AlertObject {
  kind: string;
  name: string;
  from: Provenance;
  /**
   * `subject` is what the alert is about; `alsoNamed` is everything else it
   * mentions. The difference is load-bearing rather than cosmetic: a
   * `KubeDeploymentReplicasMismatch` carries a `pod` label, and that pod is
   * kube-state-metrics rather than anything the reader wants opened.
   */
  role: "subject" | "alsoNamed";
}

export type AlertFormat =
  "alertmanagerText" | "alertmanagerSubject" | "grafana" | "datadog";

export interface AlertReading {
  format: AlertFormat;
  alertName: string | null;
  severity: string | null;
  cluster: Named<string> | null;
  namespace: Named<string> | null;
  /** Subject first. Empty where the text names no object at all. */
  objects: AlertObject[];
  container: Named<string> | null;
  firedAt: Named<number> | null;
  /** The alert's own words, verbatim, never this app's. */
  claim: string | null;
  /**
   * Keys the text carried that name the monitoring side rather than the
   * cluster, listed so a reader can see they were seen and dropped.
   */
  ignored: string[];
  /** Values from a subject line, which carries no keys to read them by. */
  unkeyed: string[];
}

/**
 * The label key names the kind, and this is the ecosystem's own table.
 *
 * These are the labels the kubernetes-mixin puts on its alerts, which is what
 * kube-prometheus-stack ships, so recognising an object is a lookup rather
 * than a guess.
 */
const KIND_OF_KEY: Record<string, string> = {
  pod: "Pod",
  deployment: "Deployment",
  statefulset: "StatefulSet",
  daemonset: "DaemonSet",
  replicaset: "ReplicaSet",
  job_name: "Job",
  cronjob: "CronJob",
  horizontalpodautoscaler: "HorizontalPodAutoscaler",
  poddisruptionbudget: "PodDisruptionBudget",
  persistentvolumeclaim: "PersistentVolumeClaim",
  persistentvolume: "PersistentVolume",
  node: "Node",
  ingress: "Ingress",
};

/**
 * Keys that name the monitoring side. Reading one as an object opens nothing.
 *
 * `job` is the trap, and it is on every alert kube-prometheus-stack sends:
 * `job=kube-state-metrics` is a Prometheus scrape job, and the Kubernetes Job
 * is `job_name`. `service` is here for the same reason: on a mixin alert it
 * is the Service that was scraped, not the one the alert is about.
 */
const MONITORING_KEYS = new Set([
  "job",
  "instance",
  "endpoint",
  "prometheus",
  "prometheus_replica",
  "service",
  "container_runtime",
  "uid",
]);

/** The same facts under Datadog's spelling. */
const DATADOG_KEYS: Record<string, string> = {
  kube_namespace: "namespace",
  pod_name: "pod",
  kube_cluster_name: "cluster",
  cluster_name: "cluster",
  kube_deployment: "deployment",
  kube_stateful_set: "statefulset",
  kube_daemon_set: "daemonset",
  kube_container_name: "container",
  kube_node: "node",
  namespace_name: "namespace",
};

/**
 * What an alert's own name says it is about, longest needle first.
 *
 * `kubelet` before `pod` or `KubeletTooManyPods` would open a pod; the
 * budget and the claim before the shorter words they contain.
 */
const KIND_IN_NAME: Array<[string, string]> = [
  ["kubelet", "Node"],
  ["poddisruptionbudget", "PodDisruptionBudget"],
  ["pdb", "PodDisruptionBudget"],
  ["persistentvolumeclaim", "PersistentVolumeClaim"],
  ["persistentvolume", "PersistentVolume"],
  ["horizontalpodautoscaler", "HorizontalPodAutoscaler"],
  ["hpa", "HorizontalPodAutoscaler"],
  ["statefulset", "StatefulSet"],
  ["daemonset", "DaemonSet"],
  ["replicaset", "ReplicaSet"],
  ["deployment", "Deployment"],
  ["cronjob", "CronJob"],
  ["container", "Pod"],
  ["pod", "Pod"],
  ["job", "Job"],
  ["node", "Node"],
];

/**
 * Which object to prefer when the alert's name settles nothing.
 *
 * A workload key is never the monitoring side, and `pod` often is, so the
 * workloads come first and the bare pod last.
 */
const FALLBACK_ORDER = [
  "deployment",
  "statefulset",
  "daemonset",
  "cronjob",
  "job_name",
  "replicaset",
  "persistentvolumeclaim",
  "persistentvolume",
  "horizontalpodautoscaler",
  "poddisruptionbudget",
  "ingress",
  "node",
  "pod",
];

const SEVERITIES = new Set(["critical", "warning", "info", "none", "error"]);

/** Marks that make a paste worth reading as an alert rather than searching for. */
const MARKS = [
  /\[(FIRING|RESOLVED)(:\d+)?\]/i,
  /\[Alerting\]/i,
  /\balertname\s*=/i,
  /^\s*Labels:\s*$/im,
  /\bTriggered:\s/i,
  /\bstartsAt\b/i,
  /\bkube_namespace\b/i,
];

/**
 * Whether this paste is an alert at all.
 *
 * Deliberately strict. A person types names into this box all day, and
 * turning an ordinary search into an alert panel would be worse than never
 * offering the panel at all.
 */
export function looksLikeAlert(text: string): boolean {
  if (text.trim().length < 12) return false;
  return MARKS.some((mark) => mark.test(text));
}

export function parseAlert(text: string): AlertReading | null {
  if (!looksLikeAlert(text)) return null;

  const labels = keyedValues(text);
  const format = formatOf(text, labels);
  const alertName = nameOf(text, labels);

  const reading: AlertReading = {
    format,
    alertName,
    severity: labels.get("severity") ?? null,
    cluster: null,
    namespace: null,
    objects: [],
    container: null,
    firedAt: firedAt(text),
    claim: claimOf(text),
    ignored: [...labels.keys()].filter((key) => MONITORING_KEYS.has(key)),
    unkeyed: [],
  };

  const cluster = labels.get("cluster");
  if (cluster !== undefined) {
    reading.cluster = { value: cluster, from: { how: "key", key: "cluster" } };
  } else {
    const host = sourceHost(text);
    // A weaker answer than a label and drawn as one: the environment is in
    // the Prometheus hostname often enough to offer, never often enough to
    // assume.
    if (host)
      reading.cluster = { value: host, from: { how: "sourceHost", host } };
  }

  const namespace = labels.get("namespace");
  if (namespace !== undefined) {
    reading.namespace = {
      value: namespace,
      from: { how: "key", key: "namespace" },
    };
  }

  const container = labels.get("container");
  if (container !== undefined) {
    reading.container = {
      value: container,
      from: { how: "key", key: "container" },
    };
  }

  reading.objects = objectsOf(labels, alertName);
  if (reading.objects.length === 0) {
    const bare = subjectValues(text);
    reading.unkeyed = bare;
    const pod =
      alertName && kindInName(alertName) === "Pod"
        ? bare.find(looksLikeGeneratedPodName)
        : undefined;
    if (pod !== undefined) {
      reading.objects = [
        {
          kind: "Pod",
          name: pod,
          from: { how: "shape", says: "podName" },
          role: "subject",
        },
      ];
      reading.unkeyed = bare.filter((value) => value !== pod);
    }
    reading.unkeyed = reading.unkeyed.filter(
      (value) => !SEVERITIES.has(value.toLowerCase())
    );
  }

  return reading;
}

/** Every `name = value` in the text, with Datadog's spellings folded in. */
function keyedValues(text: string): Map<string, string> {
  const found = new Map<string, string>();
  const line = /^[\s\-*•]*([a-z_][a-z0-9_]*)\s*[=:]\s*(.+?)\s*$/gim;
  for (const match of text.matchAll(line)) {
    const raw = match[1].toLowerCase();
    const value = match[2].replace(/^["']|["',]$/g, "").trim();
    if (value === "" || value.includes(" ")) continue;
    const key = DATADOG_KEYS[raw] ?? raw;
    if (!found.has(key)) found.set(key, value);
  }
  for (const match of text.matchAll(
    /\b([a-z_][a-z0-9_]*):([a-z0-9][a-z0-9._-]*)\b/gi
  )) {
    const raw = match[1].toLowerCase();
    const key = DATADOG_KEYS[raw];
    if (key && !found.has(key)) found.set(key, match[2]);
  }
  return found;
}

function formatOf(text: string, labels: Map<string, string>): AlertFormat {
  if (/\bkube_namespace\b|\bpod_name\b|\bkube_cluster_name\b/.test(text)) {
    return "datadog";
  }
  if (/\[Alerting\]|^\s*Silence:|^\s*Dashboard:/im.test(text)) return "grafana";
  if (labels.size > 0) return "alertmanagerText";
  return "alertmanagerSubject";
}

function nameOf(text: string, labels: Map<string, string>): string | null {
  const labelled = labels.get("alertname");
  if (labelled) return labelled;
  const subject = /\[(?:FIRING|RESOLVED)(?::\d+)?\]\s*([^(\n]+)/i.exec(text);
  if (subject) return subject[1].trim() || null;
  const grafana = /\[Alerting\]\s*([^\n]+)/i.exec(text);
  if (grafana) return grafana[1].trim() || null;
  const triggered = /\bTriggered:\s*([^\n]+?)(?:\s+on\s+\S+)?\s*$/im.exec(text);
  return triggered ? triggered[1].trim() : null;
}

/** The kind an alert's own name is about, or null where it names none. */
export function kindInName(alertName: string): string | null {
  const lower = alertName.toLowerCase();
  for (const [needle, kind] of KIND_IN_NAME) {
    if (lower.includes(needle)) return kind;
  }
  return null;
}

function objectsOf(
  labels: Map<string, string>,
  alertName: string | null
): AlertObject[] {
  const named = [...labels.entries()].filter(
    ([key]) => KIND_OF_KEY[key] !== undefined
  );
  if (named.length === 0) return [];

  const wanted = alertName ? kindInName(alertName) : null;
  // The name only expresses a preference. `KubePersistentVolumeFillingUp` is
  // labelled with a claim and no volume, so a preference nothing satisfies
  // falls through rather than dropping the object the alert really carries.
  const preferred = named.find(([key]) => KIND_OF_KEY[key] === wanted);
  const first =
    preferred ??
    FALLBACK_ORDER.map((key) =>
      named.find(([candidate]) => candidate === key)
    ).find((entry) => entry !== undefined) ??
    named[0];

  const rest = named.filter(([key]) => key !== first[0]);
  return [
    {
      kind: KIND_OF_KEY[first[0]],
      name: first[1],
      from: preferred ? { how: "alertName" } : { how: "key", key: first[0] },
      role: "subject",
    },
    ...rest.map((entry): AlertObject => ({
      kind: KIND_OF_KEY[entry[0]],
      name: entry[1],
      from: { how: "key", key: entry[0] },
      role: "alsoNamed",
    })),
  ];
}

/**
 * The values in a subject line's parentheses.
 *
 * Alertmanager renders them as values joined by spaces with the keys thrown
 * away, and the short Telegram templates people write send exactly that one
 * line. There is nothing to point at, which is why what comes out of here is
 * offered as candidates rather than as fields.
 */
function subjectValues(text: string): string[] {
  const match = /\[(?:FIRING|RESOLVED)(?::\d+)?\][^(\n]*\(([^)\n]*)\)/i.exec(
    text
  );
  if (!match) return [];
  return match[1].split(/\s+/).filter(Boolean);
}

/** `web-7b6d9c5f4-x8k2p`, the shape a controller gives a pod it made. */
export function looksLikeGeneratedPodName(value: string): boolean {
  return /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?-[a-z0-9]{5,10}-[a-z0-9]{5}$/.test(
    value
  );
}

function sourceHost(text: string): string | null {
  const match = /^\s*Source:\s*(\S+)\s*$/im.exec(text);
  if (!match) return null;
  try {
    return new URL(match[1]).hostname;
  } catch {
    return null;
  }
}

const WHEN_KEYS =
  /(?:Started|Fired at|Triggered at|StartsAt|startsAt|Since|Began)\s*:?\s*/i;

function firedAt(text: string): Named<number> | null {
  for (const line of text.split("\n")) {
    const at = WHEN_KEYS.exec(line);
    if (!at) continue;
    const rest = line.slice(at.index + at[0].length).trim();
    const when = readTime(rest);
    if (when !== null) {
      return { value: when, from: { how: "key", key: at[0].trim() } };
    }
  }
  return null;
}

/**
 * A moment, only where the text carries a date.
 *
 * A bare `03:14 UTC` would have to be dated by guessing which day, and a
 * window opened on the wrong day is worse than no window: it shows a calm
 * hour and reads as "nothing happened".
 */
function readTime(raw: string): number | null {
  const iso =
    /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?\s*(?:Z|UTC|[+-]\d{2}:?\d{2})?/.exec(
      raw
    );
  if (!iso) return null;
  const normal = iso[0].replace(" ", "T").replace(/\s*UTC$/, "Z");
  const parsed = Date.parse(
    /[Z+]|-\d{2}:?\d{2}$/.test(normal) ? normal : `${normal}Z`
  );
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * The alert's own sentence.
 *
 * An annotation where there is one, because that is what the rule's author
 * wrote for a human to read. Never assembled from labels: what this returns
 * is shown in quotation marks, and a sentence this app composed does not
 * belong inside them.
 */
function claimOf(text: string): string | null {
  for (const key of ["description", "summary", "message"]) {
    const match = new RegExp(`^[\\s\\-*•]*${key}\\s*[=:]\\s*(.+)$`, "im").exec(
      text
    );
    if (match) return match[1].replace(/^["']|["']$/g, "").trim();
  }
  const alert = /^\s*Alert:\s*(.+)$/im.exec(text);
  return alert ? alert[1].trim() : null;
}

/** Why a context is being offered for an alert that did not settle one. */
export type WhyThisCluster =
  "namedExactly" | "nameAppearsInIt" | "inTheSourceHost" | "yoursToPick";

export interface ClusterChoice {
  context: string;
  why: WhyThisCluster;
}

/**
 * Which of this kubeconfig's clusters the alert meant.
 *
 * Settled only by an exact name. Everything else is offered: two clusters
 * whose names both contain the alert's word is the case where guessing sends
 * somebody to read a healthy copy of the thing that is down, and a `cluster`
 * label naming a cluster this kubeconfig does not have is not an answer
 * either, however confident the label sounds.
 */
export function clusterChoices(
  reading: Pick<AlertReading, "cluster">,
  contexts: string[]
): { settled: string | null; choices: ClusterChoice[] } {
  const named = reading.cluster;
  if (named && named.from.how === "key") {
    const exact = contexts.find((context) => context === named.value);
    if (exact !== undefined) return { settled: exact, choices: [] };
    const near = contexts.filter(
      (context) =>
        context.includes(named.value) || named.value.includes(context)
    );
    if (near.length > 0) {
      return {
        settled: null,
        choices: near.map((context) => ({
          context,
          why: "nameAppearsInIt" as const,
        })),
      };
    }
  }
  if (named && named.from.how === "sourceHost") {
    const parts = new Set(named.from.host.split("."));
    const inHost = contexts.filter((context) => parts.has(context));
    if (inHost.length > 0) {
      return {
        settled: null,
        choices: inHost.map((context) => ({
          context,
          why: "inTheSourceHost" as const,
        })),
      };
    }
  }
  return {
    settled: null,
    choices: contexts.map((context) => ({
      context,
      why: "yoursToPick" as const,
    })),
  };
}
