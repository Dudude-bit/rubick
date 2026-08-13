/**
 * Which namespaces the window is looking at, and the one string the backend
 * is told about.
 *
 * ## Two values, and why there have to be two
 *
 * Every list command in this app takes one `Option<String>` namespace, and
 * that is the right shape for the API server: a `LIST` is scoped to one
 * namespace or to none. So the *selection* — which can be several — and the
 * *wire value* are different things:
 *
 * - **none selected** is the whole cluster, and asks for the whole cluster.
 * - **one selected** asks for that one, exactly as it always did. Nothing in
 *   the app changes shape for the case almost everybody is in.
 * - **several selected** has no wire value at all, so what it asks for
 *   depends on what is being asked — see below.
 *
 * ## What several namespaces actually costs
 *
 * Two kinds of answer, and only one of them is free:
 *
 * - A **list** is read once, cluster-wide, and narrowed here. Not because
 *   filtering in the browser is nice, but because the alternative — one
 *   request and one watch stream per namespace, per list, per page —
 *   multiplies the cost of every screen by the size of the selection. One
 *   read is never more than "All namespaces" already costs, which is a bill
 *   this app has always been willing to pay.
 * - An **aggregate** arrives already reduced and cannot be taken apart again:
 *   a cluster-wide `47 pods` under a two-namespace label states a number
 *   nobody measured. The overview and the events feed's limit are therefore
 *   asked once per namespace and joined here, and those two cost the size of
 *   the selection.
 *
 * The overview is the most expensive query in the app by a wide margin (see
 * `lib/refresh.ts`), so the second bullet is what {@link SCOPE_LIMIT} exists
 * to bound. The first is why the limit can be as generous as it is: nothing
 * else in the app gets dearer as the selection grows.
 *
 * ## What is stored, and what an older build reads back
 *
 * The selection is persisted in two places, and both of them are fields that
 * predate it: `ClusterPreferences.namespaces` holds one opaque string per
 * context, and a scope tab holds one more. A build without this feature reads
 * either straight into `currentNamespace` — handed `"prod,staging"` it would
 * ask the API server for a namespace that does not exist and show empty lists
 * on every screen without ever saying why.
 *
 * So neither field ever holds a joined list. Both hold {@link wireNamespace}:
 * `""` or one namespace, which every build back to the first one understands.
 * The selection itself rides beside them in `ScopeTab.scope`, which older
 * builds do not read. Downgrading therefore loses the extra namespaces and
 * says so — the window reopens on "All namespaces", a superset of what was
 * selected and labelled as exactly that — instead of on an empty screen.
 *
 * {@link decodeScope} still parses a joined list, because builds of this
 * feature before that was settled wrote one.
 */

/**
 * How many namespaces one window may watch at once.
 *
 * Counted from `get_cluster_overview`: the cluster-wide overview is fifteen
 * requests and a namespaced one is sixteen — and one of those sixteen is a
 * *full cluster* pod LIST, because the scheduler panel divides requests by
 * every node's allocatable and is cluster-wide whatever the scope. The window
 * asks for the cluster-wide overview however narrow the selection is (the
 * namespace picker exists to show the namespaces you are *not* on) and for
 * one more per namespace selected, every ten seconds. The bill therefore runs
 * about 90 requests a minute at "All namespaces", 186 at one namespace —
 * which is what this app has always cost — and about 480 at four, five of
 * them whole-cluster pod lists every poll.
 *
 * Four is a judgement rather than a line something crosses at five: it holds
 * the window to about two and a half times what one namespace costs, well
 * short of the ~700 a minute this same query ran up before `lib/refresh.ts`
 * slowed it down, and it covers what people actually ask for — prod beside
 * staging, or an app's namespace beside the one its database lives in. An
 * unbounded selection has no such ceiling at all: a dozen namespaces is over
 * 1200 requests a minute, and nothing on screen would say so.
 *
 * Enforced where a selection is *made* — `clusterStore.setNamespaceScope`, and
 * the picker that calls it — rather than where it is read. A bound applied at
 * the reading end would leave the window labelled with more namespaces than
 * its numbers cover, which is the one thing no surface here may do.
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
export function scopeLabel(scope: readonly string[]): string {
  if (scope.length === 0) return "All namespaces";
  if (scope.length === 1) return scope[0];
  if (scope.length === 2) return `${scope[0]}, ${scope[1]}`;
  return `${scope.length} namespaces`;
}

/** The same thing inside a sentence: "no events in …". */
export function scopeIn(scope: readonly string[]): string {
  if (scope.length === 0) return "any namespace";
  if (scope.length === 1) return scope[0];
  return `${scope.length} namespaces`;
}
