/**
 * A forward is a choice about *this laptop*, so it is kept beside the alias
 * and the colour rather than in the kubeconfig or the shared config file.
 */

import { beforeEach, describe, expect, it } from "vitest";

import {
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
  useClusterForwardStore.setState({ forwards: {} });
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
    expect(
      useClusterForwardStore.getState().forwards.prod.prometheus.autoStart
    ).toBe(false);

    setAutoStart("prod", "prometheus", true);
    expect(
      useClusterForwardStore.getState().forwards.prod.prometheus.autoStart
    ).toBe(true);
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
      Object.keys(useClusterForwardStore.getState().forwards.prod)
    ).toEqual(["prometheus"]);

    forget("prod", "prometheus");
    expect(useClusterForwardStore.getState().forwards).toEqual({});
  });
});
