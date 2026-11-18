// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { entriesOf, entryOf, named } from "@/lib/named";
import { reload } from "@/test/reload";

import { useColumnWidthsStore } from "./columnWidthsStore";

const state = () => useColumnWidthsStore.getState();

beforeEach(() => {
  localStorage.clear();
  useColumnWidthsStore.setState({ widths: named() });
});

describe("the widths a reader dragged", () => {
  /**
   * Reported on #178: a pod's name is long, its prefix is shared, and the
   * column cannot be widened. A width that forgot itself on the way to the
   * next page would be a control that does not hold, which is why this is a
   * store and not component state.
   */
  it("keeps one table's columns apart from another's", () => {
    state().set("pods", { name: 520 });
    state().set("deployments", { name: 300 });
    expect(entryOf(state().widths, "pods")).toEqual({ name: 520 });
    expect(entryOf(state().widths, "deployments")).toEqual({ name: 300 });
  });

  /**
   * A later write REPLACES what the table said before — it does not merge.
   *
   * The distinction is the whole of double-click-to-reset: the table hands
   * back a copy of its sizing with one key deleted, so a `set` that merged
   * would put the deleted key straight back and the reset would silently do
   * nothing. Written with a key that disappears, because two writes that
   * both name the same keys pass either way.
   */
  it("forgets a column the new widths no longer name", () => {
    state().set("pods", { name: 520, node: 300 });
    state().set("pods", { name: 620 });
    expect(entryOf(state().widths, "pods")).toEqual({ name: 620 });
    expect(Object.keys(entryOf(state().widths, "pods") ?? {})).toEqual([
      "name",
    ]);
  });

  /**
   * The way back to the declared widths. Removing the entry rather than
   * writing zeroes is what lets the column definitions answer again — a
   * stored `0` would be a width, and a very narrow one.
   */
  it("forgets a table rather than storing nothing for it", () => {
    state().set("pods", { name: 520 });
    state().reset("pods");
    expect(entryOf(state().widths, "pods")).toBeUndefined();
    expect("pods" in state().widths).toBe(false);
  });

  it("does nothing for a table it never knew", () => {
    const before = state().widths;
    state().reset("nodes");
    expect(state().widths).toBe(before);
  });
});

describe("tables filed under names like what every object has", () => {
  /**
   * A table is filed under what it lists, which a cluster can name
   * `__proto__` or `constructor`. Fails if widths filed under either are
   * lost, read back for a table nobody sized, dropped by a restart, or left
   * out; and if forgetting a table nobody sized writes anything.
   */
  it("keeps, restores and lists the widths of __proto__ and constructor", async () => {
    for (const [at, key] of ["pods", "__proto__", "constructor"].entries())
      state().set(key, { name: 100 + at });
    await reload(useColumnWidthsStore);
    expect(entriesOf(state().widths)).toEqual([
      ["pods", { name: 100 }],
      ["__proto__", { name: 101 }],
      ["constructor", { name: 102 }],
    ]);
    const before = state().widths;
    state().reset("toString");
    expect(state().widths).toBe(before);
    state().reset("__proto__");
    expect(entriesOf(state().widths).map(([key]) => key)).toEqual([
      "pods",
      "constructor",
    ]);
  });
});
