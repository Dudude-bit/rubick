import type {
  EventInfo,
  PodRow,
  SharedCause,
  UnreadNamespace,
} from "@/generated/types";
import type { T } from "@/i18n/useT";
import type { ResourceMetrics } from "@/lib/metrics";
import { statusRole, type StatusRole } from "@/lib/status-role";
import { kubeletWarned, sharedText } from "@/lib/pod-cause";
import { causeDeadlines, workloadCause } from "@/lib/share/pod-status";
import { createRefusal, refusalText, refusedUid } from "@/lib/create-refusal";
import { causeTextPx } from "../../-list/columns";

/** What a list row says of the cause its pods share: still reading them, could not read them, or what they told; first, that the API server refuses them. */
export type RowCause =
  | { says: "refused"; said: string }
  | { says: "reading" }
  | { says: "unread" }
  | { says: "read"; shared: SharedCause | null };

/** A workload list's row as its columns read it. */
export type WorkloadRow<Row> = Row & ResourceMetrics & { podsCause: RowCause };

/**
 * Where a row's verdict leaves its pods' cause: unsaid once it is settled,
 * said when they tell one, and where it is trouble, that they were not read.
 */
export type RowVerdict = "settled" | "open" | "trouble";

/** A verdict by the role its word is drawn in. */
export const verdictByRole = (
  role: StatusRole,
  settled: boolean
): RowVerdict =>
  settled ? "settled" : role === "err" || role === "warn" ? "trouble" : "open";

/** A Job's, which leaves its pods' cause unsaid once complete, as its page does. */
export const jobVerdict = (status: string) =>
  verdictByRole(statusRole(status), status === "Complete");

/** The workload whose pods tell a row's cause: its own, or a CronJob's run, whose uid the row does not carry. */
export type CauseOwner = { kind: string; name: string; uid?: string };

type ListedPod = PodRow & { kubeletWarned?: boolean };

export interface RowPods {
  byOwner: ReadonlyMap<string, ListedPod[]>;
  deadlines: readonly number[];
  unread: ReadonlySet<string>;
}

const ownerKey = (kind: string, namespace: string, name: string) =>
  `${kind}\0${namespace}\0${name}`;

/** Each pod under the workload Rust read off its owner, as the list's verdicts count them. */
export function rowPods(
  pods: readonly ListedPod[],
  unread: readonly UnreadNamespace[]
): RowPods {
  const byOwner = new Map<string, ListedPod[]>();
  const deadlines: number[] = [];
  for (const pod of pods) {
    if (!pod.workload) continue;
    const key = ownerKey(pod.workload.kind, pod.namespace, pod.workload.name);
    const own = byOwner.get(key);
    if (own) own.push(pod);
    else byOwner.set(key, [pod]);
    deadlines.push(...causeDeadlines(pod));
  }
  return {
    byOwner,
    deadlines,
    unread: new Set(unread.map((namespace) => namespace.namespace)),
  };
}

/**
 * What the API server refuses the controller behind a row, read beside the
 * pods it has: a Deployment carries its `ReplicaSet`'s refusal, the rest are
 * told by their events. Nothing is claimed while either is unread.
 */
export function rowRefusal(
  row: { namespace: string; podsRefused?: string | null },
  owner: CauseOwner | null,
  pods: RowPods | null,
  refusals: readonly EventInfo[] | null
): string | null {
  if (row.podsRefused !== undefined) return row.podsRefused;
  if (!owner || !pods || !refusals || pods.unread.has(row.namespace))
    return null;
  const uid =
    owner.uid ?? refusedUid(refusals, owner.kind, row.namespace, owner.name);
  if (!uid) return null;
  const own = pods.byOwner.get(ownerKey(owner.kind, row.namespace, owner.name));
  return createRefusal(
    uid,
    refusals,
    (own ?? []).map((pod) => pod.createdAt)
  );
}

const READING: RowCause = { says: "reading" };
const UNREAD: RowCause = { says: "unread" };
const NONE: RowCause = { says: "read", shared: null };

/**
 * The cause `owner`'s pods share at `now`, as the workload's page tells it:
 * what they are setting up counts only where their kubelet warned, which a
 * list does not ask.
 */
export function rowCause(
  namespace: string,
  owner: CauseOwner | null,
  pods: RowPods | null,
  now: number,
  refused: string | null = null
): RowCause {
  if (refused !== null) return { says: "refused", said: refused };
  if (!pods) return READING;
  if (pods.unread.has(namespace)) return UNREAD;
  if (!owner) return NONE;
  const told = workloadCause(
    pods.byOwner.get(ownerKey(owner.kind, namespace, owner.name)) ?? [],
    now
  );
  if (!told) return NONE;
  const cause = told.warnedOnly
    ? kubeletWarned(told.shared.cause)
    : told.shared.cause;
  return cause ? { says: "read", shared: { ...told.shared, cause } } : NONE;
}

/** The words a row says beside its verdict, for a hover, a shared file and a width. */
export function rowCauseText(
  cause: RowCause,
  verdict: RowVerdict,
  t: T
): string | null {
  if (verdict === "settled") return null;
  if (cause.says === "refused") return refusalText(cause.said, t);
  if (cause.says === "read") return cause.shared && sharedText(cause.shared, t);
  if (verdict === "open") return null;
  return t(
    "readings",
    cause.says === "reading" ? "rowCauseReading" : "rowCauseUnread"
  );
}

/** What the widest cause its rows say adds to a column, a still-reading one aside so the column does not jump. */
export function causeCellPx(
  rows: readonly { podsCause: RowCause; verdict: RowVerdict }[],
  t: T
): number {
  const said = rows.flatMap(({ podsCause, verdict }) => {
    if (podsCause.says === "reading") return [];
    const text = rowCauseText(podsCause, verdict, t);
    return text ? [text] : [];
  });
  return causeTextPx(said);
}
