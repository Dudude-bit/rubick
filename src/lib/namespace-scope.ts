/**
 * Which namespaces the window is looking at, and the one string the backend
 * is told about.
 *
 * A `LIST` is scoped to one namespace or to none, and the selection can be
 * several, so the selection and the one-namespace wire value are different
 * things: none selected asks for the cluster, one asks for that one, several
 * has no wire value at all.
 *
 * A list page hands the backend the selection itself ({@link wireScope}),
 * which reads several namespaces one `LIST` and one watch apiece and says
 * which of them did not answer. The overview is asked for the whole
 * selection and adds it up in the backend, and the events feed's limit is
 * asked per namespace and joined. All of it costs more per namespace
 * selected, which is what {@link SCOPE_LIMIT} bounds, and the overview is
 * the priciest query in the app (`lib/refresh.ts`).
 *
 * Both places the selection persists are fields that predate it, and an older
 * build reads either straight into `currentNamespace` — `"prod,staging"`
 * would ask for a namespace that does not exist and empty every screen
 * without saying why. So neither ever holds a joined list: both hold
 * {@link wireNamespace}, and the selection rides in `ScopeTab.scope`, which
 * older builds ignore. Downgrading loses the extra namespaces and reopens on
 * "All namespaces" — a superset, labelled as one. {@link decodeScope} still
 * parses a joined list, because early builds of this feature wrote one.
 */

import type { Scoped, UnreadNamespace } from "@/generated/types";
import type { T } from "@/i18n/useT";

/**
 * How many namespaces one window may watch at once.
 *
 * Counted from `get_cluster_overview`, when it has to list rather than read
 * its watches: the cluster-wide overview is fifteen requests, and one for a
 * selection is four cluster reads — metrics, the namespace count, the nodes
 * and one *full cluster* pod LIST, because the scheduler panel divides
 * requests by every node's allocatable — plus twelve per namespace. The
 * window asks for the cluster-wide overview however narrow the selection is
 * (the namespace picker exists to show the namespaces you are *not* on) and
 * for the selection's, every ten seconds: about 90 requests a minute at "All
 * namespaces", 186 at one namespace, about 400 at four, two of them
 * whole-cluster pod lists a poll. From the watches it is about 260 at four.
 *
 * Four covers what people actually ask for — prod beside staging, or an
 * app's namespace beside the one its database lives in. Reading the cluster
 * once instead of once per namespace would pay for a fifth at the overview's
 * old cost of four, but the events feed and every list across the selection
 * still ask once per namespace, and nothing made those cheaper.
 *
 * Enforced where a selection is *made* — `clusterStore.setNamespaceScope`, and
 * the picker that calls it — rather than where it is read. A bound applied at
 * the reading end would leave the window labelled with more namespaces than
 * its numbers cover.
 */
export const SCOPE_LIMIT = 4;

/** The selection, cut to what the app can answer for. See {@link SCOPE_LIMIT}. */
export function clampScope(scope: readonly string[]): string[] {
  return scope.slice(0, SCOPE_LIMIT);
}

/** The wire value: `""` for the whole cluster, or the one namespace to ask for. */
export function wireNamespace(scope: readonly string[]): string {
  return scope.length === 1 ? scope[0] : "";
}

/**
 * The cache key a scoped list rides under: `null` or a single namespace as
 * always, and a selection of several as its own key — sorted and joined, which
 * no real namespace can be (a name holds no comma), so two multi-namespace
 * selections never read each other's rows.
 */
export function scopeCacheKey(scope: readonly string[]): string | null {
  if (scope.length === 0) return null;
  if (scope.length === 1) return scope[0];
  return [...scope].sort().join(",");
}

/**
 * The scope as a `list_*_in` command takes it: `null` for the whole cluster,
 * otherwise the names. Several are read one `LIST` apiece in the backend,
 * never cluster-wide — a namespace-scoped RBAC user is refused that, and the
 * picker exists for them.
 */
export function wireScope(scope: readonly string[]): string[] | null {
  return scope.length === 0 ? null : [...scope];
}

/** A read that answers whole or fails whole: nothing in it can be unread. */
export function whole<T>(rows: T[]): Scoped<T> {
  return { rows, unread: [] };
}

/**
 * Several reads of one scope as one answer — a kind each, say. Every
 * namespace one of them could not read is named once, with the first reason.
 */
export function joinScoped<T>(parts: readonly Scoped<T>[]): Scoped<T> {
  const unread = new Map<string, UnreadNamespace>();
  for (const part of parts) {
    for (const missing of part.unread) {
      if (!unread.has(missing.namespace))
        unread.set(missing.namespace, missing);
    }
  }
  return {
    rows: parts.flatMap((part) => part.rows),
    unread: [...unread.values()],
  };
}

/**
 * A fresh answer under a live watch. The watch keeps the cached rows of every
 * namespace current, so a namespace this read timed out in keeps them rather
 * than turning unread: dropping them left the watch streaming changes into
 * rows the page no longer had.
 *
 * Only where the cache has read it. A namespace the cache itself still holds
 * as unread — a watch that has not synced yet — has no rows to keep, and
 * clearing it drew the namespace as read and empty.
 */
export function keepWatched<T extends { namespace?: string | null }>(
  answer: Scoped<T>,
  watched: Scoped<T> | undefined
): Scoped<T> {
  if (!watched || answer.unread.length === 0) return answer;
  const blind = new Set(watched.unread.map((u) => u.namespace));
  const kept = new Set(
    answer.unread.flatMap((u) => (blind.has(u.namespace) ? [] : [u.namespace]))
  );
  return {
    rows: [
      ...answer.rows,
      ...watched.rows.filter((row) => kept.has(row.namespace ?? "")),
    ],
    unread: answer.unread.filter((u) => blind.has(u.namespace)),
  };
}

/** The namespaces of `scope` that answered. */
export function answeredIn(
  scope: readonly string[],
  unread: readonly UnreadNamespace[]
): string[] {
  return scope.filter((name) => !unread.some((u) => u.namespace === name));
}

/**
 * "None" said only of the namespaces that answered — and when none did, not
 * said at all.
 */
export function noneWhereAnswered(
  t: T,
  label: string,
  scope: readonly string[],
  unread: readonly UnreadNamespace[]
): string {
  const answered = answeredIn(scope, unread);
  return answered.length === 0
    ? t("empty", "couldNotReadInScope", { label })
    : t("empty", "noneWhereAnswered", {
        label,
        namespaces: answered.join(", "),
      });
}

/** What a stored value means, including one an older build wrote. */
export function decodeScope(stored: string | null | undefined): string[] {
  if (!stored) return [];
  return [
    ...new Set(
      stored
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name !== "")
    ),
  ];
}

/** Whether two selections are the same window. */
export function sameScope(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((name, index) => name === b[index]);
}

/** Whether an object in this namespace is in scope. */
export function inScope(
  scope: readonly string[],
  namespace: string | null | undefined
): boolean {
  // Nothing selected is the whole cluster, including the cluster-scoped
  // objects that have no namespace at all.
  if (scope.length === 0) return true;
  // A cluster-scoped object stays in: a StorageClass does not stop existing
  // because somebody narrowed the window to two namespaces, and a Nodes page
  // that emptied itself would be the filter answering a question nobody asked.
  if (!namespace) return true;
  return scope.includes(namespace);
}

/** What the scope is called, for a tab strip and a page description. */
export function scopeLabel(scope: readonly string[], t: T): string {
  if (scope.length === 0) return t("cluster", "allNamespaces");
  if (scope.length === 1) return scope[0];
  if (scope.length === 2) return `${scope[0]}, ${scope[1]}`;
  return t("readings", "argoNamespaceCount", { n: scope.length });
}

/** The same thing inside a sentence: "no events in …". */
export function scopeIn(scope: readonly string[], t: T): string {
  if (scope.length === 0) return t("empty", "anyNamespace");
  if (scope.length === 1) return scope[0];
  return t("readings", "argoNamespaceCount", { n: scope.length });
}

/**
 * The items of the selected namespace, or all of them.
 *
 * `""` is this app's word for "the whole cluster" — the store types
 * `currentNamespace` as a `string`, so every consumer writes
 * `currentNamespace || null` to get a nullable out of it. A `== null` test
 * against the raw value compiles, is never true, and filters every row away:
 * that is the sidebar's Gateways and Routes rows reading 0 above pages
 * listing forty. Named here so the rule has one home and a test.
 */
export function inNamespace<T extends { namespace: string }>(
  items: T[],
  scope: string | null
): T[] {
  if (!scope) return items;
  return items.filter((item) => item.namespace === scope);
}
