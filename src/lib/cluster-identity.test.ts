import { describe, expect, it } from "vitest";

import {
  CLUSTER_HUES,
  DANGER_CLUSTER_COLOR,
  clusterColor,
  clusterHueColor,
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

describe("a colour chosen by hand", () => {
  it("beats the one derived from the name", () => {
    expect(clusterColor("k3d-dev", 224)).toBe(clusterHueColor(224));
    expect(clusterColor("k3d-dev", 224)).not.toBe(clusterColor("k3d-dev"));
  });

  it("beats the danger colour, because the derivation cannot read", () => {
    // `product-catalog-dev` is not production, and the substring rule has
    // no way to know that. The reader does.
    expect(clusterColor("product-catalog-dev")).toBe(DANGER_CLUSTER_COLOR);
    expect(clusterColor("product-catalog-dev", 92)).toBe(clusterHueColor(92));
  });

  it("leaves the derived colour alone when nothing was chosen", () => {
    expect(clusterColor("k3d-dev", null)).toBe(clusterColor("k3d-dev"));
    expect(clusterColor("eks-prod", undefined)).toBe(DANGER_CLUSTER_COLOR);
  });

  it("spends only the hue, so both themes keep their own calibration", () => {
    expect(clusterHueColor(184)).toBe("hsl(184 var(--ident-s) var(--ident-l))");
  });
});

describe("the hues on offer", () => {
  it("keeps every pair far enough apart to be told apart", () => {
    for (let i = 1; i < CLUSTER_HUES.length; i++) {
      expect(CLUSTER_HUES[i] - CLUSTER_HUES[i - 1]).toBeGreaterThanOrEqual(40);
    }
  });

  it("offers nothing that could be mistaken for the danger colour", () => {
    // The warm arc is `--err` and `--warn`, and 340 is close enough to red
    // at a 6px dot that a chosen colour could impersonate production.
    for (const hue of CLUSTER_HUES) {
      expect(hue).toBeGreaterThan(60);
      expect(hue).toBeLessThan(340);
    }
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
