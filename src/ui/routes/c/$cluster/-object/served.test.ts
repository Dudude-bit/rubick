import { describe, expect, it } from "vite-plus/test";

import type { ApiCatalog, CatalogEntry } from "@/generated/types";
import { servedIn, servedOf } from "./served";

const LEASES: CatalogEntry = {
  group: "coordination.k8s.io",
  version: "v1",
  kind: "Lease",
  plural: "leases",
  namespaced: true,
  verbs: ["get", "list", "watch"],
  shortNames: [],
};

const catalog = (unread: string[] = []): ApiCatalog => ({
  entries: [LEASES],
  unread: unread.map((group) => ({
    group,
    code: "INTERNAL_ERROR",
    message: `${group} did not answer`,
  })),
});

describe("the kind an address names", () => {
  /** kubectl's reading: the part after the first dot is the group. */
  it("splits a dotted name into its plural and group", () => {
    expect(servedOf("leases.coordination.k8s.io")).toEqual({
      plural: "leases",
      group: "coordination.k8s.io",
    });
  });

  /** A registry kind outside the core group would otherwise be asked for in it. */
  it("reads a bare plural in the group the registry gives it", () => {
    expect(servedOf("horizontalpodautoscalers").group).toBe("autoscaling");
  });

  /** Anything else bare is a core kind, as kubectl reads `serviceaccounts`. */
  it("reads an unknown bare plural in the core group", () => {
    expect(servedOf("podtemplates")).toEqual({
      plural: "podtemplates",
      group: "",
    });
  });
});

describe("whether the cluster serves a kind", () => {
  it("finds a kind its group listed", () => {
    expect(
      servedIn(catalog(), null, {
        group: "coordination.k8s.io",
        plural: "leases",
      })
    ).toEqual({ state: "served", entry: LEASES });
  });

  /**
   * The whole point: a group whose discovery failed must not read as a group
   * with no such kind. Both have no entry; only one of them is an answer.
   */
  it("cannot tell when the kind's group did not answer", () => {
    expect(
      servedIn(catalog(["example.com"]), null, {
        group: "example.com",
        plural: "widgets",
      })
    ).toEqual({ state: "unknown", error: "example.com did not answer" });
  });

  it("says absent only when the group answered without the kind", () => {
    expect(
      servedIn(catalog(["example.com"]), null, {
        group: "coordination.k8s.io",
        plural: "widgets",
      })
    ).toEqual({ state: "absent" });
  });

  /** A catalogue that failed whole knows nothing about any kind. */
  it("cannot tell anything when the catalogue failed", () => {
    expect(
      servedIn(undefined, new Error("forbidden"), {
        group: "",
        plural: "pods",
      }).state
    ).toBe("unknown");
  });
});
