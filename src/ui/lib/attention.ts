/**
 * What needs attention in a scope, as one list for every surface that counts
 * it: the Overview's panel, the sidebar badge, the status bar and Share.
 *
 * Nothing here judges an object. Each kind is handed to the reader its own
 * page uses (the backend's problems for pods, workloads, Jobs and nodes;
 * `serviceHealthOf`, `ingressHealthOf` and `autoscalerVerdict` for the
 * rest), and this only collects what they flag, worst first, beside every
 * kind it could not look at.
 */

import type {
  AutoscalerInfo,
  ClusterOverview,
  ClusterProblem,
  IngressHealthInput,
  PersistentVolumeClaimInfo,
  ProblemDetail,
  Scoped,
  ServiceHealthInputs,
} from "@/generated/types";
import type { T } from "@/i18n/useT";
import { ERROR_CODES, errorCode, errorToShow } from "@/lib/error-utils";
import { autoscalerVerdict } from "@/lib/governance";
import { isRolloutCode, ownStatusWord, rolloutWord } from "@/lib/status-words";
import { ingressHealthWords, type IngressHealth } from "@/lib/ingress-health";
import { serviceHealthOf, serviceHealthWords } from "@/lib/service-health";

export type AttentionTone = "err" | "warn";

export type AttentionDetail = ProblemDetail | { says: "ours"; text: string };

export interface AttentionItem {
  key: string;
  tone: AttentionTone;
  kind: string;
  name: string;
  namespace: string | null;
  /** The cluster's word for it, or the verdict its reader prints. */
  reason: string;
  detail: AttentionDetail | null;
  since: string | null;
  restarts: number | null;
  /** The failed pods a failed Job's row stands for instead of listing them. */
  foldedPods: number | null;
  /** Where the row opens: the object itself, or what an autoscaler scales. */
  opens: { kind: string; name: string; namespace: string | null };
  /** The IngressClass it asks for that nothing serves, and what else is wrong with it. */
  unservedClass?: { name: string; rest: string | null };
}

/** A reach, or one object's input, that could not be read. */
export interface Unread {
  namespace: string | null;
  code: string;
  message: string;
}

export interface AttentionCheck {
  kind: string;
  state: "read" | "reading" | "unread";
  unread: Unread[];
}

/** Where reads went unread, in words: one namespace, several, or the whole cluster. */
export function unreadWhere(unread: readonly Unread[], t: T): string {
  const named = [
    ...new Set(
      unread.flatMap((entry) => (entry.namespace ? [entry.namespace] : []))
    ),
  ];
  if (named.length === 0) return t("cluster", "attentionClusterWide");
  return named.length === 1
    ? t("cluster", "attentionInNamespace", { namespace: named[0] })
    : t("cluster", "attentionInNamespaces", { n: named.length });
}

/** An unread check every reach of which refused it, rather than failed. */
export const checkRefused = (check: AttentionCheck): boolean =>
  check.state === "unread" &&
  check.unread.length > 0 &&
  check.unread.every((entry) => entry.code === ERROR_CODES.PERMISSION);

export interface Attention {
  /** Worst first, then the longest broken (undated first, as the backend ranks). */
  items: AttentionItem[];
  /** Every problem, counting the rows the backend's ranked list cut. */
  total: number;
  checks: AttentionCheck[];
  /** Every kind in `checks` was read: only then is an empty list "nothing". */
  complete: boolean;
  worst: AttentionTone | null;
  /** Each namespace's problems, counting the rows the backend's cut dropped. */
  byNamespace: ReadonlyMap<string, number>;
  /** What a workload's controller says where its pods went unread: named as not checked, never counted. */
  unconfirmed: AttentionItem[];
}

/** One namespace's share of an attention read across several. */
export interface NamespaceAttention {
  total: number;
  complete: boolean;
  worst: AttentionTone | null;
}

/** A query's answer as these readers take it. */
export interface Answer<V> {
  data: V | undefined;
  /** The latest look failed, whatever the answer before it said. */
  error: unknown;
  /** Older than the rate it is read at allows: a re-read is due or under way. */
  overdue?: boolean;
}

/** Longest a claim may sit Pending before it counts: provisioning takes seconds. */
const CLAIM_GRACE_MS = 60_000;

/** The kinds the backend's answer covers, in the order they are named. */
const BACKEND_KINDS = [
  "Pod",
  "Deployment",
  "StatefulSet",
  "DaemonSet",
  "Job",
  "Node",
] as const;

/** One cached answer per reader: the shell and the page ask with the same inputs. */
function remember<A extends unknown[], R>(
  compute: (...args: A) => R
): (...args: A) => R {
  let last: { args: A; result: R } | null = null;
  return (...args: A) => {
    if (last && args.every((arg, at) => Object.is(arg, last!.args[at])))
      return last.result;
    const result = compute(...args);
    last = { args, result };
    return result;
  };
}

const ROLLOUT_KINDS = new Set(["Deployment", "StatefulSet", "DaemonSet"]);

/** The row's reason in the reader's language where the app reached it; every other reason is the cluster's and stays as written. */
export function reasonWord(
  item: Pick<AttentionItem, "kind" | "reason">,
  t: T
): string {
  if (ROLLOUT_KINDS.has(item.kind) && isRolloutCode(item.reason))
    return rolloutWord(item.reason, t);
  return item.kind === "Job" || item.kind === "Pod"
    ? (ownStatusWord(item.reason, t) ?? item.reason)
    : item.reason;
}

const keyOf = (item: Omit<AttentionItem, "key">) =>
  `${item.kind}/${item.namespace ?? "-"}/${item.name}/${item.reason}`;

const withKey = (item: Omit<AttentionItem, "key">): AttentionItem => ({
  ...item,
  key: keyOf(item),
});

const itemOf = (problem: ClusterProblem): AttentionItem =>
  withKey({
    tone: problem.severity === "critical" ? "err" : "warn",
    kind: problem.kind,
    name: problem.name,
    namespace: problem.namespace,
    reason: problem.reason,
    detail: problem.detail,
    since: problem.since,
    restarts: problem.restarts,
    foldedPods: problem.foldedPods,
    opens: {
      kind: problem.kind,
      name: problem.name,
      namespace: problem.namespace,
    },
  });

const problemItems = remember((problems: ClusterProblem[]) =>
  problems.map(itemOf)
);

const unconfirmedItems = remember((problems: ClusterProblem[]) =>
  problems.map(itemOf)
);

function toneOf(role: string): AttentionTone | null {
  return role === "err" || role === "warn" ? role : null;
}

const serviceItems = remember(
  (answered: ServiceHealthInputs[], t: T): AttentionItem[] =>
    answered.flatMap(({ namespace, groups }) =>
      groups.flatMap((group) => {
        const health = serviceHealthOf(group, group, null);
        // Some addresses not ready is the workload's verdict to give; a
        // Service with none serving is a fact no other reader reports.
        if (health.state !== "noEndpoints" && health.state !== "noneReady")
          return [];
        const words = serviceHealthWords(health, t);
        const tone = toneOf(words.role);
        if (!tone) return [];
        return group.names.map((name) => {
          const subject = { kind: "Service", name, namespace };
          return withKey({
            ...subject,
            tone,
            reason: words.label,
            detail: words.reason ? { says: "ours", text: words.reason } : null,
            since: null,
            restarts: null,
            foldedPods: null,
            opens: subject,
          });
        });
      })
    )
);

interface Judged {
  items: AttentionItem[];
  /** Ingresses whose inputs were not read, with why where it is known. */
  unknown: Unread[];
  reading: boolean;
}

function unservedClassOf(
  health: IngressHealth,
  t: T
): AttentionItem["unservedClass"] {
  const missing = health.problems.find(
    (problem) => problem.kind === "noController"
  );
  if (missing?.kind !== "noController" || !missing.className) return undefined;
  const rest = health.problems.filter((problem) => problem !== missing);
  return {
    name: missing.className,
    rest:
      rest.length > 0
        ? ingressHealthWords({ ...health, problems: rest }, t).reason
        : null,
  };
}

const ingressItems = remember(
  (
    rows: IngressHealthInput[],
    healthOf: (ingress: IngressHealthInput) => IngressHealth,
    t: T
  ): Judged => {
    const judged: Judged = { items: [], unknown: [], reading: false };
    for (const ingress of rows) {
      const health = healthOf(ingress);
      const words = ingressHealthWords(health, t);
      if (words.code === "reading") {
        judged.reading = true;
        continue;
      }
      if (words.code === "unknown") {
        judged.unknown.push({
          namespace: ingress.namespace,
          code: "",
          message: words.reason ?? "",
        });
        continue;
      }
      const tone = toneOf(words.role);
      if (!tone) continue;
      const subject = {
        kind: "Ingress",
        name: ingress.name,
        namespace: ingress.namespace,
      };
      judged.items.push(
        withKey({
          ...subject,
          tone,
          reason: words.label,
          detail: words.reason ? { says: "ours", text: words.reason } : null,
          since: null,
          restarts: null,
          foldedPods: null,
          opens: subject,
          unservedClass: unservedClassOf(health, t),
        })
      );
    }
    return judged;
  }
);

const autoscalerItems = remember((rows: AutoscalerInfo[]): AttentionItem[] =>
  rows.flatMap(({ autoscaler, target }) => {
    if (autoscaler.facts?.kind !== "autoscaler") return [];
    const verdict = autoscalerVerdict(autoscaler.facts);
    const tone = verdict && toneOf(verdict.tone);
    if (!verdict || !tone) return [];
    const decided = verdict.condition;
    return [
      withKey({
        tone,
        kind: autoscaler.kind,
        name: autoscaler.name,
        namespace: autoscaler.namespace,
        reason:
          decided?.reason ||
          (decided ? `${decided.type}=${decided.status}` : verdict.says),
        detail: decided?.message
          ? { says: "said", text: decided.message }
          : null,
        since: decided?.lastTransitionTime ?? null,
        restarts: null,
        foldedPods: null,
        opens: {
          kind: target.kind,
          name: target.name,
          namespace: target.namespace,
        },
      }),
    ];
  })
);

const claimItems = remember(
  (rows: PersistentVolumeClaimInfo[], now: number, t: T): AttentionItem[] =>
    rows.flatMap((claim) => {
      if (claim.status !== "Pending") return [];
      const created = claim.createdAt ? Date.parse(claim.createdAt) : NaN;
      // Undated claims still report: an unknown age is not evidence of a young one.
      if (now - created < CLAIM_GRACE_MS) return [];
      const subject = {
        kind: "PersistentVolumeClaim",
        name: claim.name,
        namespace: claim.namespace,
      };
      return [
        withKey({
          ...subject,
          tone: "warn",
          reason: "Pending",
          detail: { says: "ours", text: t("cluster", "claimPendingDetail") },
          since: claim.createdAt,
          restarts: null,
          foldedPods: null,
          opens: subject,
        }),
      ];
    })
);

/** A list read across the scope: still reading, failed whole, or the reaches it lost. */
function checkOf<V>(
  kind: string,
  read: Answer<Scoped<V>>,
  extra: Unread[] = [],
  reading = false
): AttentionCheck {
  if (read.error) {
    return {
      kind,
      state: "unread",
      unread: [
        {
          namespace: null,
          code: errorCode(read.error),
          message: errorToShow(read.error),
        },
      ],
    };
  }
  if (read.data === undefined) return { kind, state: "reading", unread: [] };
  const unread = [...read.data.unread, ...extra];
  if (unread.length > 0) return { kind, state: "unread", unread };
  return {
    kind,
    state: reading || read.overdue ? "reading" : "read",
    unread: [],
  };
}

export interface AttentionInputs {
  overview: ClusterOverview;
  services: {
    answered: ServiceHealthInputs[];
    unread: Unread[] | "reading";
    overdue?: boolean;
  };
  ingresses: Answer<Scoped<IngressHealthInput>>;
  ingressHealth: (ingress: IngressHealthInput) => IngressHealth;
  autoscalers: Answer<Scoped<AutoscalerInfo>>;
  claims: Answer<Scoped<PersistentVolumeClaimInfo>>;
  now: number;
}

const SEVERITY: Record<AttentionTone, number> = { err: 0, warn: 1 };

const dated = (since: string | null) =>
  since === null ? 0 : Date.parse(since) || 0;

function ranked(items: AttentionItem[]): AttentionItem[] {
  return [...items].sort(
    (a, b) =>
      SEVERITY[a.tone] - SEVERITY[b.tone] || dated(a.since) - dated(b.since)
  );
}

export type AttentionLine =
  | { at: "item"; item: AttentionItem; grouped: boolean }
  | { at: "unserved"; className: string; members: number };

/**
 * The list as it is drawn: Ingresses asking for the same missing IngressClass
 * sit under one line that says so, where the first of them ranked.
 */
export function attentionLines(items: AttentionItem[]): AttentionLine[] {
  const byClass = new Map<string, AttentionItem[]>();
  for (const item of items) {
    const name = item.unservedClass?.name;
    if (name) byClass.set(name, [...(byClass.get(name) ?? []), item]);
  }
  const lines: AttentionLine[] = [];
  const placed = new Set<string>();
  for (const item of items) {
    const name = item.unservedClass?.name;
    const members = name ? (byClass.get(name) ?? []) : [];
    if (!name || members.length < 2) {
      lines.push({ at: "item", item, grouped: false });
      continue;
    }
    if (placed.has(name)) continue;
    placed.add(name);
    lines.push({ at: "unserved", className: name, members: members.length });
    for (const member of members)
      lines.push({ at: "item", item: member, grouped: true });
  }
  return lines;
}

/** "2 failed pods", where a row stands for runs it folded. */
export const foldedWords = (item: AttentionItem, t: T): string | null =>
  item.foldedPods
    ? t("count", "failedPodsFolded", { n: item.foldedPods })
    : null;

function countByNamespace(
  overview: ClusterOverview,
  backend: AttentionItem[],
  ours: AttentionItem[]
): Map<string, number> {
  const loads = overview.namespaces ?? [];
  const counts = new Map(
    loads.map((load) => [load.name, load.problemCount] as const)
  );
  for (const item of loads.length > 0 ? ours : [...backend, ...ours]) {
    if (item.namespace === null) continue;
    counts.set(item.namespace, (counts.get(item.namespace) ?? 0) + 1);
  }
  return counts;
}

/** A count some kind went unread for is a floor, and every badge marks it so. */
export const attentionFigure = ({
  total,
  complete,
}: Pick<Attention, "total" | "complete">): string =>
  complete ? String(total) : `${total}+`;

/** The same count in words, alike on every surface that has room for them. */
export function attentionWords(
  { total, complete }: Pick<Attention, "total" | "complete">,
  t: T
): string {
  if (complete) return t("cluster", "problemCount", { n: total });
  return total > 0
    ? t("cluster", "problemCountPartial", { n: total })
    : t("cluster", "problemsNotAllChecked");
}

export const ATTENTION_TEXT = {
  err: "text-err",
  warn: "text-warn",
} as const satisfies Record<AttentionTone, string>;

/**
 * The share of `attention` the Overview scoped to `namespace` would count:
 * complete only where no kind went unread across it or in it.
 */
export function namespaceAttention(
  attention: Attention,
  namespace: string
): NamespaceAttention {
  return {
    total: attention.byNamespace.get(namespace) ?? 0,
    complete: attention.checks.every(
      (check) =>
        check.state === "read" ||
        (check.state === "unread" &&
          check.unread.every(
            (entry) => entry.namespace !== null && entry.namespace !== namespace
          ))
    ),
    worst:
      attention.items.find((item) => item.namespace === namespace)?.tone ??
      null,
  };
}

export function attentionOf(input: AttentionInputs, t: T): Attention {
  const { overview, services } = input;
  const ingress = ingressItems(
    input.ingresses.data?.rows ?? [],
    input.ingressHealth,
    t
  );
  const backend = problemItems(overview.problems);
  const ours = [
    ...serviceItems(services.answered, t),
    ...ingress.items,
    ...autoscalerItems(input.autoscalers.data?.rows ?? []),
    ...claimItems(input.claims.data?.rows ?? [], input.now, t),
  ];
  const items = ranked([...backend, ...ours]);

  const checks: AttentionCheck[] = [
    ...BACKEND_KINDS.map((kind): AttentionCheck => {
      const unread = overview.unread.filter((entry) => entry.kind === kind);
      return { kind, state: unread.length > 0 ? "unread" : "read", unread };
    }),
    services.unread === "reading"
      ? { kind: "Service", state: "reading", unread: [] }
      : {
          kind: "Service",
          state:
            services.unread.length > 0
              ? "unread"
              : services.overdue
                ? "reading"
                : "read",
          unread: services.unread,
        },
    checkOf("Ingress", input.ingresses, ingress.unknown, ingress.reading),
    checkOf("HorizontalPodAutoscaler", input.autoscalers),
    checkOf("PersistentVolumeClaim", input.claims),
  ];

  return {
    items,
    total: items.length + overview.problemsTruncated,
    checks,
    complete: checks.every((check) => check.state === "read"),
    worst: items[0]?.tone ?? null,
    byNamespace: countByNamespace(overview, backend, ours),
    unconfirmed: unconfirmedItems(overview.unconfirmed),
  };
}
