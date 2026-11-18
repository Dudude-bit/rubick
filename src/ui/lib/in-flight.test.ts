import { describe, expect, it, vi } from "vite-plus/test";

import { namesRebound } from "@/lib/kept-by-name";
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

  /**
   * A switch to another cluster and back while the first read was going
   * read the first cluster again: one read was held, for whichever cluster
   * asked last. Fails if a cluster's read in flight is not shared after
   * another cluster asked in between.
   */
  it("keeps each cluster's read in flight while another cluster asks", async () => {
    const settle: Array<(value: string) => void> = [];
    const read = vi.fn(
      () => new Promise<string>((resolve) => settle.push(resolve))
    );
    const shared = inFlightOnce(read);
    useClusterStore.setState({ currentContext: "prod" });
    const first = shared();
    useClusterStore.setState({ currentContext: "staging" });
    const staging = shared();
    useClusterStore.setState({ currentContext: "prod" });
    expect(shared()).toBe(first);
    expect(read).toHaveBeenCalledTimes(2);
    settle.forEach((resolve, at) => resolve(`read#${at}`));
    expect(await staging).toBe("read#1");
  });

  /**
   * A kubeconfig change that put another cluster behind `prod` while its
   * read was going handed the next call the old cluster's answer. Fails if
   * a call after the names were rebound shares the read from before, or
   * that read settling lets go of the new one.
   */
  it("reads again once the kubeconfig may have put another cluster behind the name", async () => {
    const settle: Array<(value: string) => void> = [];
    const read = vi.fn(
      () => new Promise<string>((resolve) => settle.push(resolve))
    );
    const shared = inFlightOnce(read);
    useClusterStore.setState({ currentContext: "prod" });
    const before = shared();
    namesRebound();
    const after = shared();
    expect(after).not.toBe(before);
    settle[0]("old cluster");
    await before;
    expect(shared()).toBe(after);
    settle[1]("new cluster");
    expect(await after).toBe("new cluster");
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
