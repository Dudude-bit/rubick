import { describe, expect, it } from "vitest";

import { EVERY_NAMESPACE, queryKeys } from "./query-keys";
import { ResourceType } from "./resource-registry";

/**
 * The app spells "every namespace" two ways — the store holds `""`, and
 * callers convert to `null` on the way to a Tauri command. Both have to
 * reach the same cache entry, or one half of the app warms a key the other
 * half never reads.
 */
describe("every namespace, however it is spelled", () => {
  const bothSpellings: Array<[string, (ns: string | null) => string[]]> = [
    ["pods", (ns) => queryKeys.pods(ns)],
    ["events", (ns) => queryKeys.events(ns)],
    ["metrics.pods", (ns) => queryKeys.metrics.pods(ns)],
    ["helm.releases", (ns) => queryKeys.helm.releases(ns)],
    ["resources", (ns) => queryKeys.resources(ResourceType.Deployment, ns)],
    ["customResourceList", (ns) => queryKeys.customResourceList("widgets", ns)],
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
    expect(queryKeys.pods(null)).toEqual(
      queryKeys.pods(storeSaysAllNamespaces)
    );
  });

  /** A named namespace still keys by its name. */
  it("keeps a real namespace apart from every namespace", () => {
    expect(queryKeys.pods("kube-system")).not.toEqual(queryKeys.pods(null));
    expect(queryKeys.pods("kube-system")).toEqual(["pods", "kube-system"]);
  });

  /**
   * `all` is a name a namespace can have — `kubectl create namespace all`
   * succeeds against a real API server. While that word was the sentinel,
   * a cluster with one keyed that namespace's pods and the whole cluster's
   * pods to the same entry, and whichever was asked first answered both.
   */
  it("does not confuse a namespace named all with all of them", () => {
    expect(queryKeys.pods("all")).not.toEqual(queryKeys.pods(null));
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
    expect(queryKeys.pods(null)).toEqual(["pods", EVERY_NAMESPACE]);
  });
});
