import { describe, expect, it } from "vite-plus/test";

import { kubectlGet } from "./kubectl";

describe("the kubectl command for an object", () => {
  it("names a built-in kind by its own word, with the namespace", () => {
    expect(
      kubectlGet({ kind: "Deployment", name: "web", namespace: "shop" })
    ).toBe("kubectl get deployment web -n shop");
  });

  it("leaves the namespace off a cluster-scoped object", () => {
    expect(
      kubectlGet({ kind: "Node", name: "worker-1", namespace: null })
    ).toBe("kubectl get node worker-1");
  });

  /** Istio ships a `gateways` too; the bare word reads whichever kubectl finds first. */
  it("spells a Gateway API kind with its group", () => {
    expect(
      kubectlGet({ kind: "Gateway", name: "edge", namespace: "infra" })
    ).toBe("kubectl get gateways.gateway.networking.k8s.io edge -n infra");
  });

  /** A kind the registry cannot spell gets no command rather than a guessed one. */
  it("offers nothing for a kind it does not know", () => {
    expect(kubectlGet({ kind: "Application", name: "shop" })).toBeNull();
  });
});
