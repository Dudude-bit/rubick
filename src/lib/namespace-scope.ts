/**
 * Which namespaces the window is looking at, and the one string the backend
 * is told about.
 *
 * A list command takes one `Option<String>`, because a `LIST` is scoped to
 * one namespace or to none. The selection can be several, so it and the wire
 * value are different things: none selected asks for the cluster, one asks
 * for that one, several has no wire value at all.
 *
 * Lists are read once cluster-wide and narrowed here — a request and a watch
 * per namespace per screen would multiply every page by the size of the
 * selection. Aggregates cannot be narrowed after the fact, so the overview
 * and the events feed's limit are asked per namespace and joined; those two
 * are what {@link SCOPE_LIMIT} bounds, and the overview is the priciest query
 * in the app (`lib/refresh.ts`).
 *
 * Both places the selection persists are fields that predate it, and an older
 * build reads either straight into `currentNamespace` — `"prod,staging"`
 * would ask for a namespace that does not exist and empty every screen
 * without saying why. So neither ever holds a joined list: both hold
 * {@link wireNamespace}, and the selection rides in `ScopeTab.scope`, which
 * older builds ignore. Downgrading loses the extra namespaces and reopens on
 * "All namespaces" — a superset, labelled as one. {@link decodeScope} parses
 * a joined list anyway, because early builds of this feature wrote one.
 */

import type { T } from "@/i18n/useT";

/**
 * How many namespaces one window may watch at once.
 *
 * Counted from `get_cluster_overview`: the cluster-wide overview is fifteen
 * requests and a namespaced one is sixteen — and one of those sixteen is a
 * *full cluster* pod LIST, because the scheduler panel divides requests by
 * every node's allocatable and is cluster-wide whatever the scope. The window
 * asks for the cluster-wide overview however narrow the selection is (the
 * namespace picker exists to show the namespaces you are *not* on) and for one
 * more per namespace selected, every ten seconds: about 90 requests a minute
 * at "All namespaces", 186 at one namespace, about 480 at four — five of them
 * whole-cluster pod lists every poll.
 *
 * Four is a judgement rather than a line something crosses at five: it holds
 * the window to about two and a half times what one namespace costs, and
 * covers what people actually ask for — prod beside staging, or an app's
 * namespace beside the one its database lives in. An unbounded selection has
 * no ceiling at all: a dozen namespaces is over 1200 requests a minute, and
 * nothing on screen would say so.
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
  // A cluster-scoped object is in every namespace scope and in none of them.
  // In: a StorageClass does not stop existing because somebody narrowed the
  // window to two namespaces, and a Nodes page that emptied itself would be
  // the filter deciding a question it was never asked.
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
 * `currentNamespace` as a `string` and every consumer writes
 * `currentNamespace || null` to get a nullable out of it. A `== null` test
 * against the raw value compiles, is never true, and filters every row away:
 * the sidebar's Gateways and Routes rows read 0 above pages listing forty
 * (4.7.3+, caught by review before release). Named here so the rule has one
 * home and a test.
 */
export function inNamespace<T extends { namespace: string }>(
  items: T[],
  scope: string | null
): T[] {
  if (!scope) return items;
  return items.filter((item) => item.namespace === scope);
}
