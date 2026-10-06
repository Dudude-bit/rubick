import { describe, expect, it } from "vite-plus/test";

import type { CustomResourceInfo } from "@/generated/types";
import { drawnSeparately, printerCell } from "./printer-columns";

describe("the printer columns the list draws itself", () => {
  /**
   * A CRD names its own printer columns. `kubectl`'s upper case is a
   * convention — Cilium writes `Age`, cert-manager writes `Age`, and a
   * case-sensitive check let both through, so every one of their kinds drew
   * two Age columns with the CRD's empty one beside ours. Fails if the
   * comparison stops folding case.
   */
  it("recognises a heading whatever case the CRD wrote it in", () => {
    for (const spelling of ["AGE", "Age", "age", " Age "]) {
      expect(drawnSeparately(spelling)).toBe(true);
    }
    for (const spelling of ["NAME", "Name", "name"]) {
      expect(drawnSeparately(spelling)).toBe(true);
    }
  });

  /** And claims nothing else: a column named after the object's own data stays. */
  it("leaves every other column to the CRD", () => {
    for (const other of ["CiliumInternalIP", "Ready", "Namespace", "Valid"]) {
      expect(drawnSeparately(other)).toBe(false);
    }
  });
});

describe("a printer column's JSONPath, as the API server reads it", () => {
  const certificate: CustomResourceInfo = {
    name: "checkout-tls",
    namespace: "shop",
    uid: "uid-1",
    apiVersion: "cert-manager.io/v1",
    kind: "Certificate",
    spec: { secretName: "checkout-tls", dnsNames: ["a.example", "b.example"] },
    status: {
      conditions: [
        { type: "Issuing", status: "False" },
        { type: "Ready", status: "True", message: "up to date" },
      ],
      revision: 3,
    },
    labels: { "app.kubernetes.io/name": "checkout" },
    annotations: {},
    createdAt: "2026-10-06T17:40:00Z",
    ownerReferences: [],
    generation: 2,
  };
  const value = (path: string) => printerCell(certificate, path);

  /**
   * cert-manager's Ready column and every condition column like it filter by
   * type. Fails if a filter, a quoted key or an index stops evaluating.
   */
  it("reads filters, quoted keys, indices and the metadata a row carries", () => {
    expect(value('.status.conditions[?(@.type=="Ready")].status')).toEqual({
      evaluated: true,
      value: "True",
    });
    expect(value(".status.conditions[?(@.status!='True')].type")).toEqual({
      evaluated: true,
      value: "Issuing",
    });
    expect(value(".status.conditions[?(@.message)].type").evaluated).toBe(true);
    expect(value(".status.revision")).toEqual({ evaluated: true, value: 3 });
    expect(value(".spec.dnsNames[-1]")).toEqual({
      evaluated: true,
      value: "b.example",
    });
    expect(value(".metadata.labels['app.kubernetes.io/name']")).toEqual({
      evaluated: true,
      value: "checkout",
    });
    expect(value(".metadata.labels.app\\.kubernetes\\.io/name")).toEqual({
      evaluated: true,
      value: "checkout",
    });
  });

  /** An absent field is the cluster's "none", which the column may say. */
  it("finds nothing in a field the object does not have", () => {
    expect(value('.status.conditions[?(@.type=="Failed")].status')).toEqual({
      evaluated: true,
      value: undefined,
    });
  });

  /**
   * Fails if a path this reader cannot parse, or metadata a list row does
   * not carry, is answered as an absent field instead of as not evaluated.
   */
  it("refuses to answer what it cannot evaluate", () => {
    for (const path of [
      ".status.conditions[?(@.type=~/Ready/)].status",
      ".spec.dnsNames[",
      "spec.secretName",
      ".metadata.resourceVersion",
      ".metadata.ownerReferences[0].name",
      "..status",
    ])
      expect(value(path)).toEqual({ evaluated: false });
  });
});
