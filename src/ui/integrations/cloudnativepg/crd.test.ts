import { describe, expect, it } from "vite-plus/test";

import type { CustomResourceInfo } from "@/generated/types";
import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import { crd } from "./crd";

const t: T = (section, key, values) => translate("en", section, key, values);

const cluster = (status: unknown): CustomResourceInfo => ({
  name: "shop-db",
  namespace: "shop",
  uid: "uid",
  apiVersion: "postgresql.cnpg.io/v1",
  kind: "Cluster",
  spec: { instances: 3 },
  status,
  labels: {},
  annotations: {},
  createdAt: null,
  generation: 1,
  ownerReferences: [],
});

const instances = (status: unknown) =>
  crd
    .columnsFor("Cluster")
    .find((column) => column.id === "instances")
    ?.accessor(cluster(status), t);

describe("the instances column of the Cluster list", () => {
  /**
   * The list read the field on its own and printed "0/3" for a Cluster
   * the operator had not reconciled, beside a page that no longer does.
   */
  it("does not count ready instances the operator has not written", () => {
    expect(instances(null)).toBe("?/3");
    expect(instances({})).toBe("?/3");
  });

  /** `omitempty` drops a zero, so a written status without the field is one. */
  it("counts what a written status says, zero included", () => {
    expect(instances({ readyInstances: 2 })).toBe("2/3");
    expect(instances({ phase: "Setting up primary" })).toBe("0/3");
  });
});
