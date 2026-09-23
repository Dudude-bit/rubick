import { describe, expect, it } from "vitest";

import { changesReplicaCount } from "./manifest-reads";

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

describe("whether a save moves the replica count", () => {
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
