import { beforeEach, describe, expect, it } from "vitest";

import { useColumnWidthsStore } from "./columnWidthsStore";

const state = () => useColumnWidthsStore.getState();

beforeEach(() => {
  localStorage.clear();
  useColumnWidthsStore.setState({ widths: {} });
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
    expect(state().widths.pods).toEqual({ name: 520 });
    expect(state().widths.deployments).toEqual({ name: 300 });
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
    expect(state().widths.pods).toEqual({ name: 620 });
    expect("node" in state().widths.pods).toBe(false);
  });

  /**
   * The way back to the declared widths. Removing the entry rather than
   * writing zeroes is what lets the column definitions answer again — a
   * stored `0` would be a width, and a very narrow one.
   */
  it("forgets a table rather than storing nothing for it", () => {
    state().set("pods", { name: 520 });
    state().reset("pods");
    expect(state().widths.pods).toBeUndefined();
    expect("pods" in state().widths).toBe(false);
  });

  it("does nothing for a table it never knew", () => {
    const before = state().widths;
    state().reset("nodes");
    expect(state().widths).toBe(before);
  });
});
