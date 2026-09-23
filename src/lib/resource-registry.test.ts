import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  RESOURCE_REGISTRY,
  ResourceType,
  kindFacts,
  listQueryFor,
  narrowingHelps,
  toPlural,
  toSingularNoun,
  type ResourceKind,
} from "./resource-registry";

/**
 * The question sent to `SelfSubjectAccessReview` is matched by the API server
 * against the same three fields this table already builds every URL from. If
 * they ever disagree, the nav marks a row about a resource nobody asked about
 * — silently, because a review that matches nothing simply answers no.
 */
describe("the question that asks whether a kind may be listed", () => {
  it("sends the core group as the empty string, not as its version", () => {
    // `v1` is a version. Sending it where a group belongs matches nothing,
    // and matching nothing reads as a refusal.
    expect(listQueryFor("Pod")).toEqual({
      group: "",
      resource: "pods",
      namespaced: true,
    });
  });

  it("sends the group in front of the slash for everything else", () => {
    expect(listQueryFor("Deployment")).toEqual({
      group: "apps",
      resource: "deployments",
      namespaced: true,
    });
    expect(listQueryFor("Ingress")).toEqual({
      group: "networking.k8s.io",
      resource: "ingresses",
      namespaced: true,
    });
  });

  // A cluster-scoped kind asked about inside a namespace is a different
  // question than the list call makes.
  it("says which kinds live outside a namespace", () => {
    expect(listQueryFor("Node").namespaced).toBe(false);
    expect(listQueryFor("PersistentVolume").namespaced).toBe(false);
    expect(listQueryFor("PersistentVolumeClaim").namespaced).toBe(true);
  });

  /**
   * Every entry, not a sample: the failure this guards against is one row of
   * the table drifting, and a sample is exactly what a drifting row hides in.
   */
  it("agrees with the table on every kind in it", () => {
    for (const entry of RESOURCE_REGISTRY) {
      const query = listQueryFor(entry.kind as ResourceKind);
      expect(query.resource).toBe(toPlural(entry.kind as ResourceKind));
      expect(query.namespaced).toBe(entry.scope !== "cluster");
      expect(entry.apiVersion.startsWith(`${query.group}/`)).toBe(
        query.group !== ""
      );
    }
  });
});

describe("toSingularNoun", () => {
  /** Trimming a letter was the old way, and it printed "1 ingresse" for a
   *  namespace with one Ingress in it. The API's plurals are not all
   *  noun + "s", and the registry already holds the singular. */
  it("reads the singular off the registry rather than trimming a letter", () => {
    expect(toSingularNoun("ingresses")).toBe("ingress");
    expect(toSingularNoun("storageclasses")).toBe("storageclass");
    expect(toSingularNoun("pods")).toBe("pod");
    expect(toSingularNoun("services")).toBe("service");
  });

  /** A kind the registry does not carry keeps whatever it was given —
   *  a wrong singular is worse than a plural that reads as one. */
  it("leaves a plural it does not know alone", () => {
    expect(toSingularNoun("widgets")).toBe("widgets");
  });
});

describe("whether picking one namespace shortens a read", () => {
  /**
   * The slow-read panel and the deadline block both offer "Pick one
   * namespace". On a cluster-scoped kind that control cannot change the
   * answer — the list is one list however it is set — so offering it sends
   * a reader to a remedy that does nothing.
   */
  it("says no for the kinds a namespace does not narrow", () => {
    for (const kind of [
      ResourceType.Node,
      ResourceType.PersistentVolume,
      ResourceType.StorageClass,
    ]) {
      expect(narrowingHelps(kind)).toBe(false);
    }
  });

  it("says yes for the kinds that live in a namespace", () => {
    for (const kind of [
      ResourceType.Pod,
      ResourceType.Deployment,
      ResourceType.ConfigMap,
    ]) {
      expect(narrowingHelps(kind)).toBe(true);
    }
  });
});

describe("the facts the registry takes from shared/kinds.json", () => {
  const file = JSON.parse(
    readFileSync(resolve(process.cwd(), "shared/kinds.json"), "utf8")
  ) as { kinds: Array<Record<string, unknown>> };

  /**
   * The Rust side checks the file against `k8s-openapi`; this side builds
   * every URL out of it. A kind in one list and not the other is a kind one
   * half cannot address, and an entry missing a fact is a URL with
   * `undefined` in it.
   */
  it("names exactly the registry's kinds, each with all four facts", () => {
    expect(file.kinds.map((facts) => facts.kind).sort()).toEqual(
      RESOURCE_REGISTRY.map((entry) => entry.kind).sort()
    );
    for (const facts of file.kinds) {
      for (const field of ["group", "version", "plural"])
        expect(typeof facts[field], `${String(facts.kind)}.${field}`).toBe(
          "string"
        );
      expect(["namespaced", "cluster"]).toContain(facts.scope);
    }
  });

  /**
   * The registry's `apiVersion` is what `getManifest` asks the cluster for,
   * and the core group has no name to put in front of the slash: `/v1` is
   * a path the API server does not serve.
   */
  it("spells a core kind's apiVersion without a group in front", () => {
    const apiVersion = (kind: string) =>
      RESOURCE_REGISTRY.find((entry) => entry.kind === kind)?.apiVersion;
    expect(apiVersion("Pod")).toBe("v1");
    expect(apiVersion("Deployment")).toBe("apps/v1");
    expect(apiVersion("HorizontalPodAutoscaler")).toBe("autoscaling/v2");
    expect(kindFacts("Pod")?.group).toBe("");
  });
});
