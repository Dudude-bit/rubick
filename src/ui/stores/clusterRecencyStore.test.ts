import { describe, expect, it } from "vitest";

import { splitByRecency } from "./clusterRecencyStore";

const contexts = [
  { name: "arn:aws:eks:eu-west-1:1:cluster/prod" },
  { name: "k3d-dev" },
  { name: "staging" },
];

describe("splitByRecency", () => {
  it("puts the clusters you use above the ones you have not", () => {
    const { recent, rest } = splitByRecency(contexts, {
      "k3d-dev": 200,
      staging: 100,
    });
    expect(recent.map((c) => c.name)).toEqual(["k3d-dev", "staging"]);
    expect(rest.map((c) => c.name)).toEqual([
      "arn:aws:eks:eu-west-1:1:cluster/prod",
    ]);
  });

  it("leaves the never-connected half in the kubeconfig's own order", () => {
    const { recent, rest } = splitByRecency(contexts, {});
    expect(recent).toEqual([]);
    expect(rest.map((c) => c.name)).toEqual(contexts.map((c) => c.name));
  });

  it("ignores a remembered cluster the kubeconfig no longer lists", () => {
    const { recent } = splitByRecency(contexts, { deleted: 999, "k3d-dev": 1 });
    expect(recent.map((c) => c.name)).toEqual(["k3d-dev"]);
  });
});
