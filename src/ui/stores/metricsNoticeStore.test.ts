// @vitest-environment jsdom
import { describe, expect, it } from "vite-plus/test";

import { nameIsAnotherCluster } from "@/lib/kept-by-name";
import { entriesOf, entryOf, named } from "@/lib/named";
import { reload } from "@/test/reload";

import { useMetricsNoticeStore } from "./metricsNoticeStore";

describe("the metrics banners put away, per cluster", () => {
  /**
   * `__proto__` and `constructor` are context names like any other. Fails
   * if a banner put away under either is lost, read back for a cluster that
   * put none away (spreading `constructor`'s function threw), dropped by a
   * restart, or left out.
   */
  it("keeps, restores and lists what __proto__ and constructor put away", async () => {
    useMetricsNoticeStore.setState({ hidden: named() });
    const { hide } = useMetricsNoticeStore.getState();
    for (const context of ["prod", "__proto__", "constructor"]) {
      hide(context, "notInstalled");
      hide(context, "forbidden");
    }
    await reload(useMetricsNoticeStore);
    const { hidden } = useMetricsNoticeStore.getState();
    expect(entriesOf(hidden)).toEqual([
      ["prod", ["notInstalled", "forbidden"]],
      ["__proto__", ["notInstalled", "forbidden"]],
      ["constructor", ["notInstalled", "forbidden"]],
    ]);
    expect(entryOf(hidden, "toString")).toBeUndefined();
  });

  /**
   * A refusal put away for the old cluster hid the new cluster's under the
   * same name. Fails if a banner put away outlives the turn of its name, or
   * another name's goes with it.
   */
  it("shows again what was put away for a name that turned into another cluster", () => {
    useMetricsNoticeStore.setState({ hidden: named() });
    const { hide } = useMetricsNoticeStore.getState();
    hide("constructor", "forbidden");
    hide("prod", "forbidden");
    nameIsAnotherCluster("constructor");
    expect(entriesOf(useMetricsNoticeStore.getState().hidden)).toEqual([
      ["prod", ["forbidden"]],
    ]);
  });
});
