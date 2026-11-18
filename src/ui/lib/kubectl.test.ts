import { describe, expect, it } from "vite-plus/test";

import { cliLine, kubectlGet } from "./kubectl";

const at = { context: "default", files: "/home/me/.kube/k3s.yaml" };
const on = "KUBECONFIG=/home/me/.kube/k3s.yaml kubectl --context default";

describe("the kubectl command for an object", () => {
  it("names a built-in kind by its own word, with the namespace", () => {
    expect(
      kubectlGet({ kind: "Deployment", name: "web", namespace: "shop" }, at)
    ).toBe(`${on} get deployment web -n shop`);
  });

  it("leaves the namespace off a cluster-scoped object", () => {
    expect(
      kubectlGet({ kind: "Node", name: "worker-1", namespace: null }, at)
    ).toBe(`${on} get node worker-1`);
  });

  /** Istio ships a `gateways` too; the bare word reads whichever kubectl finds first. */
  it("spells a Gateway API kind with its group", () => {
    expect(
      kubectlGet({ kind: "Gateway", name: "edge", namespace: "infra" }, at)
    ).toBe(`${on} get gateways.gateway.networking.k8s.io edge -n infra`);
  });

  /** A kind the registry cannot spell gets no command rather than a guessed one. */
  it("offers nothing for a kind it does not know", () => {
    expect(kubectlGet({ kind: "Application", name: "shop" }, at)).toBeNull();
  });
});

describe("a line the app hands out to run", () => {
  /**
   * Two kubeconfig files can each call a cluster `default`. Fails if a line
   * leaves out the context or the files the app read it from, which sends
   * the terminal's kubectl or helm to its own cluster of that name.
   */
  it("names the cluster on screen and the files it was read from", () => {
    expect(cliLine("helm", at, "list -n shop")).toBe(
      "KUBECONFIG=/home/me/.kube/k3s.yaml helm list -n shop --kube-context default"
    );
    expect(
      cliLine(
        "kubectl",
        { context: "my cluster's prod", files: "/Users/me/My Files/config" },
        "get pods"
      )
    ).toBe(
      "KUBECONFIG='/Users/me/My Files/config' kubectl --context 'my cluster'\\''s prod' get pods"
    );
  });

  /** Fails if a context or files not known yet leave the flag out instead of a stand-in to fill. */
  it("puts a stand-in where the cluster is not known", () => {
    expect(cliLine("kubectl", { context: null, files: null }, "get pods")).toBe(
      "KUBECONFIG=FILES kubectl --context CONTEXT get pods"
    );
  });
});
