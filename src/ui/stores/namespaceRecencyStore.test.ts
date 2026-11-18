// @vitest-environment jsdom
import { describe, expect, it } from "vite-plus/test";

import { nameIsAnotherCluster } from "@/lib/kept-by-name";
import { entriesOf, entryOf, named } from "@/lib/named";
import { reload } from "@/test/reload";

import { useNamespaceRecencyStore } from "./namespaceRecencyStore";

describe("the namespaces last used, per cluster", () => {
  /**
   * `__proto__` and `constructor` are context names like any other. Fails
   * if the namespaces used under either are lost, read back as a property
   * every object has (spreading `constructor`'s threw), dropped by a
   * restart, or left out of the list.
   */
  it("keeps, restores and lists the namespaces of __proto__ and constructor", async () => {
    useNamespaceRecencyStore.setState({ recent: named() });
    const { record } = useNamespaceRecencyStore.getState();
    for (const context of ["prod", "__proto__", "constructor"]) {
      record(context, ["first"]);
      record(context, [`then-${context}`]);
    }
    await reload(useNamespaceRecencyStore);
    const { recent } = useNamespaceRecencyStore.getState();
    expect(entriesOf(recent)).toEqual([
      ["prod", ["then-prod", "first"]],
      ["__proto__", ["then-__proto__", "first"]],
      ["constructor", ["then-constructor", "first"]],
    ]);
    expect(entryOf(recent, "toString")).toBeUndefined();

    nameIsAnotherCluster("__proto__");
    expect(
      entriesOf(useNamespaceRecencyStore.getState().recent).map(([c]) => c)
    ).toEqual(["prod", "constructor"]);
  });

  /** A store from before its version is read through `migrate`: fails if it loses `__proto__` there. */
  it("keeps __proto__ through a store written at an older version", async () => {
    localStorage.setItem(
      "namespace-recency",
      '{"state":{"recent":{"__proto__":["shop"],"prod":["a"]}},"version":0}'
    );
    await useNamespaceRecencyStore.persist.rehydrate();
    expect(
      entryOf(useNamespaceRecencyStore.getState().recent, "__proto__")
    ).toEqual(["shop"]);
  });
});
