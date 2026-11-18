/**
 * A forward is a choice about *this laptop*, so it is kept beside the alias
 * and the colour rather than in the kubeconfig or the shared config file.
 */
// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { nameIsAnotherCluster } from "@/lib/kept-by-name";
import { entryOf, named } from "@/lib/named";
import { reload } from "@/test/reload";

import {
  forwardOf,
  forwardsFor,
  useClusterForwardStore,
  type ForwardPreference,
} from "./clusterForwardStore";

const preference = (
  overrides: Partial<ForwardPreference> = {}
): ForwardPreference => ({
  namespace: "monitoring",
  service: "prometheus-operated",
  remotePort: 9090,
  localPort: 20001,
  autoStart: false,
  ...overrides,
});

beforeEach(() => {
  useClusterForwardStore.setState({ forwards: named() });
});

describe("what a cluster forwards", () => {
  it("keeps one per vendor per cluster", () => {
    const { remember } = useClusterForwardStore.getState();
    remember("prod", "prometheus", preference());
    remember("prod", "loki", preference({ localPort: 20002 }));
    remember("staging", "prometheus", preference({ localPort: 20003 }));

    const { forwards } = useClusterForwardStore.getState();
    expect(
      forwardsFor(forwards, "prod")
        .map(([id]) => id)
        .sort()
    ).toEqual(["loki", "prometheus"]);
    expect(forwardsFor(forwards, "staging")).toHaveLength(1);
    expect(forwardsFor(forwards, "unknown")).toEqual([]);
  });

  /**
   * Off until asked for: a forward is a listening socket on this machine and
   * a connection into the cluster, and neither is opened because somebody
   * pressed a button once.
   */
  it("does not start on its own until somebody says so", () => {
    const { remember, setAutoStart } = useClusterForwardStore.getState();
    remember("prod", "prometheus", preference());
    const autoStart = () =>
      forwardOf(
        useClusterForwardStore.getState().forwards,
        "prod",
        "prometheus"
      )?.autoStart;
    expect(autoStart()).toBe(false);

    setAutoStart("prod", "prometheus", true);
    expect(autoStart()).toBe(true);
  });

  /** Toggling something that was never saved must not invent an entry. */
  it("ignores an auto-start for a forward that does not exist", () => {
    useClusterForwardStore.getState().setAutoStart("prod", "prometheus", true);
    expect(useClusterForwardStore.getState().forwards).toEqual({});
  });

  /** Forgetting the last one leaves no residue behind, like the marks store. */
  it("drops a cluster that no longer forwards anything", () => {
    const { remember, forget } = useClusterForwardStore.getState();
    remember("prod", "prometheus", preference());
    remember("prod", "loki", preference());

    forget("prod", "loki");
    expect(
      forwardsFor(useClusterForwardStore.getState().forwards, "prod").map(
        ([id]) => id
      )
    ).toEqual(["prometheus"]);

    forget("prod", "prometheus");
    expect(useClusterForwardStore.getState().forwards).toEqual({});
  });
});

describe("clusters named like what every object has", () => {
  /**
   * `__proto__` and `constructor` are context names like any other. Fails
   * if a forward saved under either is lost (assigning `__proto__` set the
   * record's prototype), read back for a cluster that saved none, dropped
   * by a restart, or left out of the list.
   */
  it("keeps, restores and lists the forwards of __proto__ and constructor", async () => {
    const { remember, setAutoStart, forget } =
      useClusterForwardStore.getState();
    expect(
      forwardsFor(useClusterForwardStore.getState().forwards, "constructor")
    ).toEqual([]);
    for (const [at, context] of [
      "prod",
      "__proto__",
      "constructor",
    ].entries()) {
      remember(context, "prometheus", preference({ localPort: 20001 + at }));
      setAutoStart(context, "prometheus", true);
    }
    await reload(useClusterForwardStore);
    const { forwards } = useClusterForwardStore.getState();
    for (const [at, context] of ["prod", "__proto__", "constructor"].entries())
      expect(forwardOf(forwards, context, "prometheus")).toEqual(
        preference({ localPort: 20001 + at, autoStart: true })
      );
    expect(forwardsFor(forwards, "toString")).toEqual([]);

    forget("__proto__", "prometheus");
    const left = useClusterForwardStore.getState().forwards;
    expect(entryOf(left, "__proto__")).toBeUndefined();
    expect(forwardsFor(left, "constructor")).toHaveLength(1);
  });
});

describe("a name that turned into another cluster", () => {
  /**
   * The Service a forward names was the old cluster's, and opening the
   * cluster woke a tunnel into the new one with it. Fails if a forward saved
   * for the old cluster outlives the turn, or another name's goes with it.
   */
  it("forgets what the old cluster forwarded and keeps the rest", () => {
    const { remember } = useClusterForwardStore.getState();
    remember("prod", "prometheus", preference({ autoStart: true }));
    remember("staging", "prometheus", preference({ localPort: 20003 }));
    nameIsAnotherCluster("prod");
    const { forwards } = useClusterForwardStore.getState();
    expect(forwardOf(forwards, "prod", "prometheus")).toBeUndefined();
    expect(forwardOf(forwards, "staging", "prometheus")?.localPort).toBe(20003);
  });
});
