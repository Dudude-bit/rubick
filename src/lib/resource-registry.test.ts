import { describe, expect, it } from "vitest";

import {
  RESOURCE_REGISTRY,
  listQueryFor,
  toPlural,
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
