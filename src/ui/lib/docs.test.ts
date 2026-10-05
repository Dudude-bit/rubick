import { describe, expect, it } from "vite-plus/test";

import { kindDocs, kindOfPath } from "./docs";

describe("the kind a page is about", () => {
  it("reads a list and an object of it alike", () => {
    expect(kindOfPath("/c/prod/pods")).toBe("Pod");
    expect(kindOfPath("/c/prod/deployments/shop/web")).toBe("Deployment");
    expect(kindOfPath("/c/prod/nodes/worker-1")).toBe("Node");
  });

  /** The overview and a custom resource are about no kind the registry names. */
  it("names none where there is none", () => {
    expect(kindOfPath("/c/prod")).toBeNull();
    expect(
      kindOfPath("/c/prod/applications.argoproj.io/argocd/shop")
    ).toBeNull();
  });

  it("points at kubernetes.io", () => {
    expect(kindDocs("Service")).toBe(
      "https://kubernetes.io/docs/concepts/services-networking/service/"
    );
  });
});
