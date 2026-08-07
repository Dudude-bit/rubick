import { describe, expect, it } from "vitest";

import {
  DANGER_CLUSTER_COLOR,
  clusterColor,
  clusterNameParts,
  detectProvider,
  isProductionContext,
  providerLabel,
} from "./cluster-identity";

describe("detectProvider", () => {
  it.each([
    ["k3d-k8s-gui-dev", "k3d"],
    ["k3s-homelab", "k3s"],
    ["arn:aws:eks:eu-west-1:123456789012:cluster/payments", "eks"],
    ["prod-eks-eu", "eks"],
    ["gke_acme-prod_europe-west4_payments", "gke"],
    ["staging-gke", "gke"],
    ["corp-aks", "aks"],
    ["minikube", "minikube"],
    ["docker-desktop", "generic"],
    ["my-cluster", "generic"],
  ] as const)("reads %s as %s", (context, provider) => {
    expect(detectProvider(context)).toBe(provider);
  });

  it("ignores case", () => {
    expect(detectProvider("K3D-Dev")).toBe("k3d");
  });

  it("does not match a marker buried inside a word", () => {
    expect(detectProvider("peaks-cluster")).toBe("generic");
    expect(detectProvider("bakery")).toBe("generic");
  });
});

describe("providerLabel", () => {
  it("labels local clusters LOCAL and unknown ones K8S", () => {
    expect(providerLabel("minikube")).toBe("LOCAL");
    expect(providerLabel("generic")).toBe("K8S");
    expect(providerLabel("eks")).toBe("EKS");
  });
});

describe("clusterColor", () => {
  it("gives anything production-looking the danger colour", () => {
    expect(clusterColor("prod-eu-west-1")).toBe(DANGER_CLUSTER_COLOR);
    expect(clusterColor("gke_acme_europe_PRODUCTION")).toBe(
      DANGER_CLUSTER_COLOR
    );
    expect(isProductionContext("eks-prod")).toBe(true);
  });

  it("is stable for the same name", () => {
    expect(clusterColor("k3d-dev")).toBe(clusterColor("k3d-dev"));
  });

  it("never hands the danger colour to a non-production cluster", () => {
    const names = Array.from({ length: 200 }, (_, i) => `cluster-${i}`);
    for (const name of names) {
      expect(clusterColor(name)).not.toBe(DANGER_CLUSTER_COLOR);
    }
  });

  it("separates neighbouring names", () => {
    const colors = new Set(
      ["dev-1", "dev-2", "dev-3", "dev-4"].map((n) => clusterColor(n))
    );
    expect(colors.size).toBeGreaterThan(1);
  });

  it("falls back to a neutral colour with no context", () => {
    expect(clusterColor(null)).toBe("hsl(var(--fg-fnt))");
  });
});

describe("clusterNameParts", () => {
  it("dims the ARN an EKS context is mostly made of", () => {
    expect(clusterNameParts("arn:aws:eks:us-east-1:1234:cluster/prod")).toEqual(
      {
        prefix: "arn:aws:eks:us-east-1:1234:cluster/",
        label: "prod",
      }
    );
  });

  it("dims the project and zone a GKE context leads with", () => {
    expect(clusterNameParts("gke_acme-prod_europe-west1_main")).toEqual({
      prefix: "gke_acme-prod_europe-west1_",
      label: "main",
    });
  });

  it("leaves a plain name whole", () => {
    expect(clusterNameParts("k3d-k8s-gui-dev")).toEqual({
      prefix: "",
      label: "k3d-k8s-gui-dev",
    });
  });

  it("keeps the whole name when the split would leave nothing to read", () => {
    expect(clusterNameParts("gke_acme_")).toEqual({
      prefix: "",
      label: "gke_acme_",
    });
  });
});
