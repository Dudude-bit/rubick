// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { renderHook } from "@testing-library/react";

import { useClusterStore } from "@/stores/clusterStore";
import { useConnectTo } from "./useConnectTo";

const connect = vi.fn(async () => {});

beforeEach(() => {
  connect.mockClear();
  useClusterStore.setState({
    currentContext: null,
    isConnected: false,
    pendingContext: null,
    connect,
  });
});

describe("the address connecting the window", () => {
  /** The address is the only thing that says which cluster this window is in. */
  it("connects to the cluster the address names", () => {
    renderHook(() => useConnectTo("prod", true));
    expect(connect).toHaveBeenCalledWith("prod", { keepRoute: true });
  });

  /** Before the kubeconfig is read, a name in the address may not exist. */
  it("waits until the cluster is known to be listed", () => {
    const { rerender } = renderHook(
      ({ ready }) => useConnectTo("prod", ready),
      { initialProps: { ready: false } }
    );
    expect(connect).not.toHaveBeenCalled();
    rerender({ ready: true });
    expect(connect).toHaveBeenCalledTimes(1);
  });

  /**
   * A kubeconfig read again (a file watcher, a tab reconciling) makes the
   * cluster known a second time. Retrying a connect that failed each time it
   * does would hammer an auth flow the reader already saw fail.
   */
  it("asks once per cluster the address arrives at", () => {
    const { rerender } = renderHook(
      ({ cluster, ready }) => useConnectTo(cluster, ready),
      { initialProps: { cluster: "prod", ready: true } }
    );
    rerender({ cluster: "prod", ready: false });
    rerender({ cluster: "prod", ready: true });
    expect(connect).toHaveBeenCalledTimes(1);
    rerender({ cluster: "dev", ready: true });
    expect(connect).toHaveBeenLastCalledWith("dev", { keepRoute: true });
  });

  /**
   * A tab on a cluster the kubeconfig lost takes the address there and
   * disconnects the window. The cluster picked on that page was the one the
   * window had been in, so it counted as already asked: the pick landed in a
   * disconnected shell and had to be made twice. Fails if coming back to a
   * cluster after a stay at one that could not be opened does not connect.
   */
  it("connects again on coming back from a cluster that could not be opened", () => {
    const { rerender } = renderHook(
      ({ cluster, ready }) => useConnectTo(cluster, ready),
      { initialProps: { cluster: "prod", ready: true } }
    );
    rerender({ cluster: "gone", ready: false });
    rerender({ cluster: "prod", ready: true });
    expect(connect).toHaveBeenCalledTimes(2);
    expect(connect).toHaveBeenLastCalledWith("prod", { keepRoute: true });
  });

  /** A tab activation already connected; a second connect would restart its auth. */
  it("leaves a connection already in flight to that cluster alone", () => {
    useClusterStore.setState({
      currentContext: "prod",
      pendingContext: "prod",
    });
    renderHook(() => useConnectTo("prod", true));
    expect(connect).not.toHaveBeenCalled();
  });
});
