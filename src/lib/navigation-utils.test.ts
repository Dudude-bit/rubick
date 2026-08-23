import { describe, it, expect } from "vitest";
import { getResourceDetailUrl } from "./navigation-utils";

describe("getResourceDetailUrl", () => {
  it("includes the namespace for namespaced resources", () => {
    expect(getResourceDetailUrl("Pod", "nginx", "default")).toBe(
      "/pods/default/nginx"
    );
    expect(getResourceDetailUrl("Deployment", "api", "production")).toBe(
      "/deployments/production/api"
    );
  });

  it("omits the namespace segment for cluster-scoped resources", () => {
    expect(getResourceDetailUrl("Node", "node-1")).toBe("/nodes/node-1");
    expect(getResourceDetailUrl("PersistentVolume", "pv-1")).toBe(
      "/persistentvolumes/pv-1"
    );
  });

  it("treats null/undefined namespace as cluster-scoped", () => {
    expect(getResourceDetailUrl("Node", "node-1", null)).toBe("/nodes/node-1");
    expect(getResourceDetailUrl("Node", "node-1", undefined)).toBe(
      "/nodes/node-1"
    );
  });

  it("treats empty-string namespace as cluster-scoped", () => {
    // Backend often returns "" instead of null for non-namespaced resources;
    // link helper must not produce //pods/... or empty segments.
    expect(getResourceDetailUrl("Node", "node-1", "")).toBe("/nodes/node-1");
  });

  /**
   * The mirror of the case `isRoutableKind` already refuses. An owner
   * reference used to arrive carrying its dependent's namespace whatever the
   * owner's own scope was — Kubernetes lets a namespaced object name a
   * cluster-scoped owner — and the path built from it addressed nothing.
   */
  it("ignores a namespace handed to a cluster-scoped kind", () => {
    expect(getResourceDetailUrl("Node", "node-1", "default")).toBe(
      "/nodes/node-1"
    );
    expect(getResourceDetailUrl("PersistentVolume", "pv-1", "production")).toBe(
      "/persistentvolumes/pv-1"
    );
    expect(getResourceDetailUrl("Namespace", "kube-system", "default")).toBe(
      "/namespaces/kube-system"
    );
  });

  /**
   * `isResourceType` accepts a plural and narrows it to `ResourceKind`, so a
   * plural reaches the scope lookup with the type system's blessing. It used
   * to find nothing there and read a property of undefined.
   */
  it("resolves a plural spelling as well as a kind", () => {
    expect(getResourceDetailUrl("pods", "nginx", "default")).toBe(
      "/pods/default/nginx"
    );
    expect(getResourceDetailUrl("nodes", "node-1", "default")).toBe(
      "/nodes/node-1"
    );
  });

  it("does not URL-encode the name (callers must pre-encode if needed)", () => {
    // Documents the contract: pod names follow DNS rules, no encoding needed.
    // If a caller ever passes a name with special chars, they own encoding.
    expect(getResourceDetailUrl("Pod", "my.pod", "default")).toBe(
      "/pods/default/my.pod"
    );
  });
});
