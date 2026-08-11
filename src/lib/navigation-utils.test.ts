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

  it("does not URL-encode the name (callers must pre-encode if needed)", () => {
    // Documents the contract: pod names follow DNS rules, no encoding needed.
    // If a caller ever passes a name with special chars, they own encoding.
    expect(getResourceDetailUrl("Pod", "my.pod", "default")).toBe(
      "/pods/default/my.pod"
    );
  });
});
