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
 * "All namespaces" — a superset, labelled as one. {@link decodeScope} still
 * parses a joined list, because early builds of this feature wrote one.
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
 * whole-cluster pod lists every poll. A dozen namespaces would be over 1200 a
 * minute, and nothing on screen would say so.
 *
 * Four holds the window to about two and a half times what one namespace
 * costs, and covers what people actually ask for — prod beside staging, or an
 * app's namespace beside the one its database lives in.
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
 * Read a list across the selection: none or one as a single `LIST`, several as
 * one request per namespace, merged. A cluster-wide `LIST` needs list rights
 * across the whole cluster, which a namespace-scoped RBAC user lacks — so every
 * such selection came back empty and unexplained. Each namespace the user can
 * read on its own, which is the whole point of the picker.
 */
export function listAcrossScope<T>(
  scope: readonly string[],
  fetchOne: (namespace: string | null) => Promise<T[]>
): () => Promise<T[]> {
  return async () => {
    if (scope.length <= 1) {
      return fetchOne(scope.length === 1 ? scope[0] : null);
    }
    // One read per namespace, settled independently. A user with rights in
    // some of the selected namespaces and not others keeps the rows they can
    // read rather than losing every namespace's rows to one namespace's
    // refusal — the failure of the old `Promise.all`, which rejected whole.
    //
    // But a failed read is still never answered with an empty list: if
    // nothing came back and a namespace refused, that refusal is the answer,
    // thrown so the list shows it. The one thing not carried here is *which*
    // namespace refused when other namespaces did return rows — surfacing that
    // beside the rows needs a richer return than this shared shape allows.
    const settled = await Promise.allSettled(scope.map((ns) => fetchOne(ns)));
    const rows: T[] = [];
    let firstError: unknown;
    let failed = false;
    for (const result of settled) {
      if (result.status === "fulfilled") {
        rows.push(...result.value);
      } else if (!failed) {
        failed = true;
        firstError = result.reason;
      }
    }
    if (failed && rows.length === 0) {
      throw firstError;
    }
    return rows;
  };
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
