import { describe, expect, it } from "vite-plus/test";

import { catalogGroups } from "./catalog-groups";

const entry = (group: string, kind: string, plural: string) => ({
  group,
  version: "v1",
  kind,
  plural,
  namespaced: true,
  verbs: ["list"],
});

const catalog = {
  entries: [
    entry("apps", "Deployment", "deployments"),
    entry("", "Pod", "pods"),
    entry("", "ConfigMap", "configmaps"),
    entry("coordination.k8s.io", "Lease", "leases"),
  ],
  unread: [{ group: "metrics.k8s.io", code: "KUBE_API", message: "503" }],
};

describe("the catalogue by group", () => {
  it("puts core first and sorts kinds by name", () => {
    const { groups, kinds } = catalogGroups(catalog, "");
    expect(groups.map((group) => group.group)).toEqual([
      "",
      "apps",
      "coordination.k8s.io",
    ]);
    expect(groups[0].entries.map((e) => e.kind)).toEqual(["ConfigMap", "Pod"]);
    expect(kinds).toBe(4);
  });

  it("matches a filter on kind, plural or group", () => {
    expect(catalogGroups(catalog, "LEASE").kinds).toBe(1);
    expect(catalogGroups(catalog, "deployments").kinds).toBe(1);
    expect(catalogGroups(catalog, "coordination").kinds).toBe(1);
  });

  /** A group nobody could read could hold the kind being looked for. */
  it("keeps the unread groups whatever the filter", () => {
    expect(catalogGroups(catalog, "nothing-like-this").unread).toHaveLength(1);
  });
});
