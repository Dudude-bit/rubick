import { describe, expect, it } from "vitest";

import { changesReplicaCount, deliveryOfManifest } from "./manifest-reads";

describe("the delivery question read out of the document itself", () => {
  it("takes the group from apiVersion, which no table has to know", () => {
    expect(
      deliveryOfManifest(
        "apiVersion: argoproj.io/v1alpha1\nkind: Application\nmetadata:\n  name: shop\n  namespace: argocd\n"
      )
    ).toMatchObject({ group: "argoproj.io", kind: "Application" });
    expect(
      deliveryOfManifest(
        "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: c\n"
      )
    ).toMatchObject({ group: "", namespace: null });
  });

  it("carries the labels and annotations the claim is written in", () => {
    const query = deliveryOfManifest(
      [
        "apiVersion: apps/v1",
        "kind: Deployment",
        "metadata:",
        "  name: api",
        "  namespace: shop",
        "  labels:",
        "    argocd.argoproj.io/instance: shop",
        "    replicas: 3",
        "  annotations:",
        "    note: hand-applied",
        "",
      ].join("\n")
    );
    expect(query?.labels).toEqual({ "argocd.argoproj.io/instance": "shop" });
    expect(query?.annotations).toEqual({ note: "hand-applied" });
  });

  it("asks nothing of a document it cannot read", () => {
    expect(deliveryOfManifest("")).toBe(null);
    expect(deliveryOfManifest("kind: Deployment\n")).toBe(null);
    expect(
      deliveryOfManifest("apiVersion: v1\nkind: Pod\nmetadata: {}\n")
    ).toBe(null);
    expect(deliveryOfManifest("this: [is: not: yaml\n")).toBe(null);
  });
});

describe("whether a save moves the replica count", () => {
  const doc = (replicas: number | null) =>
    [
      "apiVersion: apps/v1",
      "kind: Deployment",
      "metadata:",
      "  name: api",
      "spec:",
      ...(replicas === null ? [] : [`  replicas: ${replicas}`]),
      "  template:",
      "    spec: {}",
      "",
    ].join("\n");

  it("reads a replica count out of either document, or neither", () => {
    expect(changesReplicaCount(doc(3), doc(null))).toBe(true);
    expect(changesReplicaCount(doc(null), doc(null))).toBe(false);
    expect(changesReplicaCount(doc(3), doc(3) + "# a comment\n")).toBe(false);
    // A document that will not parse is about to fail on the API server, and
    // its message is better than anything guessed here.
    expect(changesReplicaCount(doc(3), "spec: [broken\n")).toBe(false);
  });
});

const deployment = (name: string, replicas: number) =>
  [
    "apiVersion: apps/v1",
    "kind: Deployment",
    "metadata:",
    `  name: ${name}`,
    "  namespace: shop",
    "spec:",
    `  replicas: ${replicas}`,
    "",
  ].join("\n");

const configMap = [
  "apiVersion: v1",
  "kind: ConfigMap",
  "metadata:",
  "  name: api-settings",
  "  namespace: shop",
  "data: {}",
  "",
].join("\n");

describe("whether a save moves the replica count, in a buffer of several documents", () => {
  /**
   * One parser call read one document and threw on a second, so a buffer
   * with an object added under `---` counted as unreadable and the
   * autoscaler warning went quiet — while the apply, which takes every
   * document, set the new count all the same.
   */
  it("reads the edited object out of a buffer with several documents", () => {
    const edited = `${deployment("api", 5)}---\n${configMap}`;
    expect(changesReplicaCount(deployment("api", 3), edited)).toBe(true);
    expect(
      changesReplicaCount(
        deployment("api", 3),
        `${configMap}---\n${deployment("api", 3)}`
      )
    ).toBe(false);
  });

  /** Another Deployment's count is not this one's. */
  it("compares the object the editor opened, not the first one it finds", () => {
    const edited = `${deployment("worker", 9)}---\n${deployment("api", 3)}`;
    expect(changesReplicaCount(deployment("api", 3), edited)).toBe(false);
  });
});
