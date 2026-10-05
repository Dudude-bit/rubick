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
  IngressHealthInput,
  PersistentVolumeClaimInfo,
  ProblemDetail,
  Scoped,
  ServiceHealthInputs,
} from "@/generated/types";
import type { T } from "@/i18n/useT";
import { errorCode, errorToShow } from "@/lib/error-utils";
import { autoscalerVerdict } from "@/lib/governance";
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
  /** Where the row opens: the object itself, or what an autoscaler scales. */
  opens: { kind: string; name: string; namespace: string | null };
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

export interface Attention {
  /** Worst first, then the longest broken (undated first, as the backend ranks). */
  items: AttentionItem[];
  /** Every problem, counting the rows the backend's ranked list cut. */
  total: number;
  checks: AttentionCheck[];
  /** Every kind in `checks` was read: only then is an empty list "nothing". */
  complete: boolean;
  worst: AttentionTone | null;
}

/** A query's answer as these readers take it. */
export interface Answer<V> {
  data: V | undefined;
  error: unknown;
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

const keyOf = (item: Omit<AttentionItem, "key">) =>
  `${item.kind}/${item.namespace ?? "-"}/${item.name}/${item.reason}`;

const withKey = (item: Omit<AttentionItem, "key">): AttentionItem => ({
  ...item,
  key: keyOf(item),
});

const problemItems = remember(
  (problems: ClusterOverview["problems"]): AttentionItem[] =>
    problems.map((problem) =>
      withKey({
        tone: problem.severity === "critical" ? "err" : "warn",
        kind: problem.kind,
        name: problem.name,
        namespace: problem.namespace,
        reason: problem.reason,
        detail: problem.detail,
        since: problem.since,
        restarts: problem.restarts,
        opens: {
          kind: problem.kind,
          name: problem.name,
          namespace: problem.namespace,
        },
      })
    )
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

const ingressItems = remember(
  (
    rows: IngressHealthInput[],
    healthOf: (ingress: IngressHealthInput) => IngressHealth,
    t: T
  ): Judged => {
    const judged: Judged = { items: [], unknown: [], reading: false };
    for (const ingress of rows) {
      const words = ingressHealthWords(healthOf(ingress), t);
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
          opens: subject,
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
  if (read.data === undefined) {
    return read.error
      ? {
          kind,
          state: "unread",
          unread: [
            {
              namespace: null,
              code: errorCode(read.error),
              message: errorToShow(read.error),
            },
          ],
        }
      : { kind, state: "reading", unread: [] };
  }
  const unread = [...read.data.unread, ...extra];
  if (unread.length > 0) return { kind, state: "unread", unread };
  return { kind, state: reading ? "reading" : "read", unread: [] };
}

export interface AttentionInputs {
  overview: ClusterOverview;
  services: {
    answered: ServiceHealthInputs[];
    unread: Unread[] | "reading";
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

export function attentionOf(input: AttentionInputs, t: T): Attention {
  const { overview, services } = input;
  const ingress = ingressItems(
    input.ingresses.data?.rows ?? [],
    input.ingressHealth,
    t
  );
  const items = ranked([
    ...problemItems(overview.problems),
    ...serviceItems(services.answered, t),
    ...ingress.items,
    ...autoscalerItems(input.autoscalers.data?.rows ?? []),
    ...claimItems(input.claims.data?.rows ?? [], input.now, t),
  ]);

  const checks: AttentionCheck[] = [
    ...BACKEND_KINDS.map((kind): AttentionCheck => {
      const unread = overview.unread.filter((entry) => entry.kind === kind);
      return { kind, state: unread.length > 0 ? "unread" : "read", unread };
    }),
    services.unread === "reading"
      ? { kind: "Service", state: "reading", unread: [] }
      : {
          kind: "Service",
          state: services.unread.length > 0 ? "unread" : "read",
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
  };
}
