import { causeTold, type AttentionItem } from "@/lib/attention";
import { ResourceType } from "@/lib/resource-registry";
import { problemOfItems, type Problem } from "./problem";

export const ownerKey = (kind: string, namespace: string, name: string) =>
  `${kind}\0${namespace}\0${name}`;

const podsOwnerKey = (item: AttentionItem) =>
  item.workload &&
  ownerKey(item.workload.kind, item.namespace ?? "", item.workload.name);

/**
 * The shell's problems a row carries, by the row's key. A workload's own
 * rollout is already its badge's word, so: what opens it from elsewhere (an
 * autoscaler that cannot scale it), and its pods' rows, less those whose
 * cause its own row tells as Needs attention folds them. These are a view
 * of items the shell counts once, never more of them.
 */
export function rowItems(
  items: readonly AttentionItem[],
  /** The rows' own kind, whose own items count: a pod's probe is its row's, not a workload's word. */
  own?: string
): ReadonlyMap<string, readonly AttentionItem[]> {
  const heads = new Map<string, AttentionItem>();
  for (const item of items)
    if (!item.workload && item.kind === item.opens.kind)
      heads.set(ownerKey(item.kind, item.namespace ?? "", item.name), item);
  const byRow = new Map<string, AttentionItem[]>();
  for (const item of items) {
    const ownItem = item.kind === item.opens.kind;
    const pods = own === undefined && ownItem ? podsOwnerKey(item) : undefined;
    const head = pods ? heads.get(pods) : undefined;
    const key =
      own === undefined
        ? ownItem
          ? head && causeTold(head, item)
            ? undefined
            : pods
          : ownerKey(
              item.opens.kind,
              item.opens.namespace ?? "",
              item.opens.name
            )
        : ownItem && item.kind === own
          ? ownerKey(item.kind, item.opens.namespace ?? "", item.opens.name)
          : undefined;
    if (key) byRow.set(key, [...(byRow.get(key) ?? []), item]);
    // An autoscaler's finding opens what it scales, and is its own row's too:
    // its page said nothing while the shell counted it.
    if (own === undefined && !ownItem) {
      const subject = ownerKey(item.kind, item.namespace ?? "", item.name);
      byRow.set(subject, [...(byRow.get(subject) ?? []), item]);
    }
  }
  return byRow;
}

/** Each row's problem out of {@link rowItems}. */
export function rowProblems(
  items: readonly AttentionItem[],
  own?: string
): ReadonlyMap<string, Problem> {
  const problems = new Map<string, Problem>();
  for (const [key, carried] of rowItems(items, own)) {
    const problem = problemOfItems(carried);
    if (problem) problems.set(key, problem);
  }
  return problems;
}

/** {@link rowItems} for one object, as its own list's row carries them: the peek's and the page chip's. */
export const itemsOfRow = (
  items: readonly AttentionItem[],
  kind: string,
  namespace: string | null,
  name: string
): AttentionItem[] => [
  ...(problemOfRow(
    rowItems(items, kind === ResourceType.Pod ? kind : undefined),
    kind,
    namespace ?? "",
    name
  ) ?? []),
];

export const problemOfRow = <V>(
  byRow: ReadonlyMap<string, V>,
  kind: string,
  namespace: string,
  name: string
): V | null => byRow.get(ownerKey(kind, namespace, name)) ?? null;
