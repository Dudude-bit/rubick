import { describe, expect, it } from "vitest";
import { QueryClient, type QueryKey } from "@tanstack/react-query";

import { EVERY_NAMESPACE, queryKeys } from "./query-keys";
import { ResourceType } from "./resource-registry";

/**
 * The app spells "every namespace" two ways — the store holds `""`, and
 * callers convert to `null` on the way to a Tauri command. Both have to
 * reach the same cache entry, or one half of the app warms a key the other
 * half never reads.
 */
describe("every namespace, however it is spelled", () => {
  const bothSpellings: Array<[string, (ns: string | null) => QueryKey]> = [
    ["podRows", (ns) => queryKeys.podRows(ns)],
    ["events", (ns) => queryKeys.events(ns)],
    ["metrics.pods", (ns) => queryKeys.metrics.pods(ns)],
    // The Helm page reads its releases through this, scoped by the window.
    ["helm.releases", (ns) => queryKeys.helm.releases(ns)],
    ["resources", (ns) => queryKeys.resources(ResourceType.Deployment, ns)],
    ["customResourceList", (ns) => queryKeys.customResourceList("widgets", ns)],
    ["clusterOverview", (ns) => queryKeys.clusterOverview("prod-eu", ns)],
  ];

  it.each(bothSpellings)(
    "%s agrees on empty, null and undefined",
    (_, build) => {
      expect(build("")).toEqual(build(null));
      expect(build(null)).toEqual(build(undefined as unknown as null));
    }
  );

  /**
   * The bug this file exists for: the connect-time prefetch passed `null`
   * and every reader passed the store's `""`, so the warmed list and the
   * read list were two entries and the prefetch was pure waste.
   */
  it("prefetching with null warms the key a reader builds from the store", () => {
    const storeSaysAllNamespaces = "";
    expect(queryKeys.podRows(null)).toEqual(
      queryKeys.podRows(storeSaysAllNamespaces)
    );
  });

  /** A named namespace still keys by its name. */
  it("keeps a real namespace apart from every namespace", () => {
    const pods = (ns: string | null) =>
      queryKeys.resources(ResourceType.Pod, ns);
    expect(pods("kube-system")).not.toEqual(pods(null));
    expect(pods("kube-system")).toEqual(["pods", "kube-system"]);
  });

  /**
   * `all` is a name a namespace can have — `kubectl create namespace all`
   * succeeds against a real API server. While that word was the sentinel,
   * a cluster with one keyed that namespace's pods and the whole cluster's
   * pods to the same entry, and whichever was asked first answered both.
   */
  it("does not confuse a namespace named all with all of them", () => {
    expect(queryKeys.podRows("all")).not.toEqual(queryKeys.podRows(null));
    expect(queryKeys.resources(ResourceType.Deployment, "all")).not.toEqual(
      queryKeys.resources(ResourceType.Deployment, null)
    );
  });

  /**
   * The sentinel has to be a string the API server refuses, or it is just
   * another name in the race. `*` fails the RFC-1123 label rule every
   * namespace name is checked against.
   */
  it("uses a sentinel no namespace can be named", () => {
    const rfc1123Label = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
    expect(rfc1123Label.test(EVERY_NAMESPACE)).toBe(false);
    expect(queryKeys.podRows(null)).toEqual(["pod-rows", EVERY_NAMESPACE]);
  });
});

/** Which of `keys` an invalidation of `prefix` marks stale. */
async function staleAfter(prefix: QueryKey, keys: QueryKey[]) {
  const client = new QueryClient();
  for (const key of keys) client.setQueryData(key, "answer");
  await client.invalidateQueries({ queryKey: prefix });
  return keys.filter((key) => client.getQueryState(key)?.isInvalidated);
}

describe("what one invalidation reaches", () => {
  /**
   * A rollback from the Helm page invalidated only the list, and one from a
   * release's page only the release and its history — so the history on a
   * workload's Changes tab, and the list behind a release page, stayed as
   * they were. Fails if a release fact moves out from under the prefix.
   */
  it("reaches every fact about every release from one Helm mutation", async () => {
    const facts = [
      queryKeys.helm.releases(null),
      queryKeys.helm.releases("shop"),
      queryKeys.helm.release("shop", "api"),
      queryKeys.helm.history("shop", "api"),
    ];
    expect(await staleAfter(queryKeys.helm.everyRelease(), facts)).toEqual(
      facts
    );
  });

  /**
   * Deleting a cloud profile changes what a context is bound to. The list of
   * bindings was invalidated and the one the dialog was holding was not.
   */
  it("reaches each context's binding along with the list of them", async () => {
    const facts = [
      queryKeys.contextBindings(),
      queryKeys.contextBinding("gke-shop"),
    ];
    expect(await staleAfter(queryKeys.contextBindings(), facts)).toEqual(facts);
  });

  /**
   * A page reads a cluster-scoped object's namespace off the route as
   * `undefined`, the peek as `null`. React Query hashes the two alike but
   * matches a filter by value, so an invalidation spelled one way missed the
   * entry spelled the other.
   */
  it("reaches a cluster-scoped object however its namespace was spelled", async () => {
    const page = queryKeys.detail("Node", undefined, "node-a");
    const peek = queryKeys.detail("Node", null, "node-a");
    expect(await staleAfter(peek, [page])).toEqual([page]);
  });
});
