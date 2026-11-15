import { describe, expect, it, vi } from "vite-plus/test";

import { useClusterStore } from "@/stores/clusterStore";
import { inFlightOnce } from "./in-flight";

describe("a read shared while in flight", () => {
  /**
   * Forty Services asked about at once read the cluster forty times. Fails if
   * calls made together read more than once, a call after the answer is
   * served a stale one, or one cluster is answered with another's read.
   */
  it("serves calls made together one read, per cluster, and reads again once it settled", async () => {
    let reads = 0;
    const read = vi.fn(async () => {
      reads += 1;
      return `${useClusterStore.getState().currentContext}#${reads}`;
    });
    const shared = inFlightOnce(read);
    useClusterStore.setState({ currentContext: "prod" });
    const together = await Promise.all([shared(), shared(), shared()]);
    expect(together).toEqual(["prod#1", "prod#1", "prod#1"]);
    expect(await shared()).toBe("prod#2");

    const prod = shared();
    useClusterStore.setState({ currentContext: "staging" });
    expect(await Promise.all([prod, shared()])).toEqual([
      "prod#3",
      "staging#4",
    ]);
  });

  /** A failed read is not kept: the next call asks again. */
  it("reads again after a read that failed", async () => {
    let fail = true;
    const shared = inFlightOnce(async () => {
      if (fail) throw new Error("refused");
      return "read";
    });
    await expect(shared()).rejects.toThrow("refused");
    fail = false;
    expect(await shared()).toBe("read");
  });
});
