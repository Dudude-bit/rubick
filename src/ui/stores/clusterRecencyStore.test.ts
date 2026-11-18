// @vitest-environment jsdom
import { describe, expect, it } from "vite-plus/test";

import { entryOf, named } from "@/lib/named";
import { reload } from "@/test/reload";

import { splitByRecency, useClusterRecencyStore } from "./clusterRecencyStore";

const contexts = [
  { name: "arn:aws:eks:eu-west-1:1:cluster/prod" },
  { name: "k3d-dev" },
  { name: "staging" },
];

describe("splitByRecency", () => {
  it("puts the clusters you use above the ones you have not", () => {
    const { recent, rest } = splitByRecency(
      contexts,
      named({
        "k3d-dev": 200,
        staging: 100,
      })
    );
    expect(recent.map((c) => c.name)).toEqual(["k3d-dev", "staging"]);
    expect(rest.map((c) => c.name)).toEqual([
      "arn:aws:eks:eu-west-1:1:cluster/prod",
    ]);
  });

  it("leaves the never-connected half in the kubeconfig's own order", () => {
    const { recent, rest } = splitByRecency(contexts, named({}));
    expect(recent).toEqual([]);
    expect(rest.map((c) => c.name)).toEqual(contexts.map((c) => c.name));
  });

  it("ignores a remembered cluster the kubeconfig no longer lists", () => {
    const { recent } = splitByRecency(
      contexts,
      named({ deleted: 999, "k3d-dev": 1 })
    );
    expect(recent.map((c) => c.name)).toEqual(["k3d-dev"]);
  });
});

describe("clusters named like what every object has", () => {
  const names = [
    { name: "prod" },
    { name: "__proto__" },
    { name: "constructor" },
  ];

  /**
   * `__proto__` and `constructor` are context names like any other. Fails if
   * a use under either is lost, read back as a property every object has,
   * dropped by a restart, or left out of the recent list; and if a context
   * nobody used reads as used because its name is one.
   */
  it("keeps, restores and lists a use under __proto__ and constructor", async () => {
    useClusterRecencyStore.setState({ lastUsed: named() });
    const { recordUse } = useClusterRecencyStore.getState();
    expect(
      splitByRecency([...names, { name: "toString" }], named()).recent
    ).toEqual([]);
    for (const { name } of names) recordUse(name);
    await reload(useClusterRecencyStore);
    const { lastUsed } = useClusterRecencyStore.getState();
    for (const { name } of names)
      expect(entryOf(lastUsed, name)).toEqual(expect.any(Number));
    const { recent, rest } = splitByRecency(
      [...names, { name: "toString" }],
      lastUsed
    );
    expect(recent.map((c) => c.name).sort()).toEqual(
      ["__proto__", "constructor", "prod"].sort()
    );
    expect(rest.map((c) => c.name)).toEqual(["toString"]);
  });

  /** A store from before its version is read through `migrate`: fails if it loses `__proto__` there. */
  it("keeps __proto__ through a store written at an older version", async () => {
    localStorage.setItem(
      "cluster-recency",
      '{"state":{"lastUsed":{"__proto__":5,"prod":4}},"version":0}'
    );
    await useClusterRecencyStore.persist.rehydrate();
    expect(
      entryOf(useClusterRecencyStore.getState().lastUsed, "__proto__")
    ).toBe(5);
  });
});
