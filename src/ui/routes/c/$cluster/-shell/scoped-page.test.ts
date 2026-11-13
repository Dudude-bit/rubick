import { describe, expect, it } from "vite-plus/test";

import { readsScope } from "./scoped-page";

describe("which pages read the window's namespaces", () => {
  /** Fails if a page that draws a namespace's contents is left to read a missing one as empty: Prometheus drew "0 monitors" for one. */
  it("counts the Overview, Events, Changes, an integration's page and every namespaced list", () => {
    for (const path of [
      "/c/prod",
      "/c/prod/",
      "/c/prod/events",
      "/c/prod/changes",
      "/c/prod/helm",
      "/c/prod/pods",
      "/c/prod/persistentvolumeclaims",
      "/c/prod/integrations/prometheus",
    ])
      expect(readsScope(path), path).toBe(true);
  });

  /** Fails if a page that never reads the scope is taken over for a namespace it does not use. */
  it("leaves cluster-wide lists and an object's own page alone", () => {
    for (const path of [
      "/c/prod/nodes",
      "/c/prod/namespaces",
      "/c/prod/storageclasses",
      "/c/prod/api-resources",
      "/c/prod/pods/shop/cart-1",
      "/c/prod/my-access",
      "/c/prod/integrations",
    ])
      expect(readsScope(path), path).toBe(false);
  });
});
