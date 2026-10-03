import { describe, expect, it } from "vitest";

import { parseRefusal, rbacRule } from "./refusal";

describe("parseRefusal", () => {
  /** A rule built from the wrong namespace or group would be asked for and still not help. */
  it("reads user, verb, resource, group and namespace out of the server's sentence", () => {
    expect(
      parseRefusal(
        'endpointslices.discovery.k8s.io is forbidden: User "kirya" cannot list resource "endpointslices" in API group "discovery.k8s.io" in the namespace "shop"'
      )
    ).toEqual({
      user: "kirya",
      verb: "list",
      resource: "endpointslices",
      group: "discovery.k8s.io",
      namespace: "shop",
    });
  });

  /** A cluster-scoped refusal has no namespace, and a Role in one would not help. */
  it("keeps the cluster scope as no namespace and a subresource whole", () => {
    expect(
      parseRefusal(
        'nodes is forbidden: User "dev" cannot list resource "nodes" in API group "" at the cluster scope'
      )?.namespace
    ).toBeNull();
    expect(
      parseRefusal(
        'pods "x" is forbidden: User "dev" cannot get resource "pods/log" in API group "" in the namespace "shop"'
      )?.resource
    ).toBe("pods/log");
  });

  /** "permission denied" from elsewhere names nothing a rule could be built from. */
  it("returns null for a refusal that names no subject", () => {
    expect(parseRefusal("permission denied")).toBeNull();
    expect(
      parseRefusal("Tauri command 'listPods' failed: connection refused")
    ).toBeNull();
  });
});

describe("rbacRule", () => {
  /** A list without get and watch is a screen that loads once and never updates. */
  it("asks for all three read verbs in the namespace the refusal named", () => {
    const rule = rbacRule({
      user: "kirya",
      verb: "list",
      resource: "endpointslices",
      group: "discovery.k8s.io",
      namespace: "shop",
    });
    expect(rule).toContain("kind: Role\n");
    expect(rule).toContain("  namespace: shop");
    expect(rule).toContain('resources: ["endpointslices"]');
    expect(rule).toContain('verbs: ["get", "list", "watch"]');
    expect(rule).toContain("kind: User\n  name: kirya");
    expect(rule).toContain("kind: RoleBinding");
  });

  /** A service account is bound by kind and namespace, not as a User string that no binding matches. */
  it("binds a service account as a ServiceAccount at the cluster scope", () => {
    const rule = rbacRule({
      user: "system:serviceaccount:auth:dex",
      verb: "delete",
      resource: "nodes",
      group: "",
      namespace: null,
    });
    expect(rule).toContain("kind: ClusterRole\n");
    expect(rule).not.toContain("namespace: null");
    expect(rule).toContain('verbs: ["delete"]');
    expect(rule).toContain(
      "- kind: ServiceAccount\n  name: dex\n  namespace: auth"
    );
  });
});
