import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { act, renderHook } from "@testing-library/react";

const toast = vi.fn();
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast }) }));

let callbacks: {
  enabled?: boolean;
  onError?: (m: string) => void;
  onRecovered?: () => void;
} = {};
vi.mock("@/hooks/useResourceWatch", () => ({
  useResourceWatch: (options: typeof callbacks) => {
    callbacks = options;
    return { resyncing: false };
  },
}));

import { credentialsRenewed } from "@/lib/credentials";
import { queryKeys } from "@/lib/query-keys";
import { useClusterStore } from "@/stores/clusterStore";
import { useListFollowed, useListLive, useWatchedList } from "./useWatchedList";

const POD_DETAIL = queryKeys.rowDetail("Pod");

const watched = (enabled = true, reportFailure?: (m: string) => void) =>
  renderHook(() =>
    useWatchedList({
      enabled,
      subscribe: () => Promise.resolve("stream"),
      queryKey: ["pods"],
      detail: POD_DETAIL,
      reportFailure,
    })
  );

describe("a list kept current by a watch", () => {
  beforeEach(() => {
    toast.mockClear();
    useClusterStore.setState((s) => ({
      connectionAttemptId: s.connectionAttemptId + 1,
    }));
  });

  /** A live list that polled anyway would be the idle cost the watch exists to remove. */
  it("does not poll while the watch runs", () => {
    const { result } = watched();
    expect(result.current).toMatchObject({ live: true, refresh: false });
  });

  /**
   * A refused watch left the list frozen, claiming to be live; the toast that
   * said so sat over the last rows. Fails if a broken watch does not fall
   * back to polling, or toasts beside the freshness mark that already says it.
   */
  it("polls without a toast over the rows when the watch fails", () => {
    const { result } = watched();
    act(() => {
      callbacks.onError?.("watch stream failed: connection reset");
      callbacks.onError?.("watch stream failed: connection reset");
    });
    expect(result.current).toMatchObject({
      live: false,
      refresh: "resourceList",
      watchFailed: true,
    });
    expect(toast).not.toHaveBeenCalled();
  });

  /**
   * Every list refused under All namespaces also popped a toast carrying the
   * raw ApiError, beside a page that already said it was refused. Fails if a
   * refused watch is toasted.
   */
  it("polls without a toast when the watch is refused", () => {
    const { result } = watched();
    act(() =>
      callbacks.onError?.(
        'failed to perform initial object list: ApiError: pods is forbidden: User "marco" cannot list resource "pods"'
      )
    );
    expect(result.current).toMatchObject({
      live: false,
      refresh: "resourceList",
    });
    expect(toast).not.toHaveBeenCalled();
  });

  /**
   * Marco's DaemonSets page subscribed a watch on every visit, refused each
   * time, two warnings in the log apiece. Fails if a watch refused on this
   * connection is subscribed again, or if the list stops polling instead.
   */
  it("does not subscribe a watch again on the connection that refused it", () => {
    const first = watched();
    act(() =>
      callbacks.onError?.(
        'ApiError: daemonsets.apps is forbidden: User "marco" cannot watch resource "daemonsets"'
      )
    );
    first.unmount();
    const { result } = watched();
    expect(callbacks.enabled).toBe(false);
    expect(result.current).toMatchObject({
      live: false,
      refresh: "resourceList",
    });

    act(() =>
      useClusterStore.setState((s) => ({
        connectionAttemptId: s.connectionAttemptId + 1,
      }))
    );
    expect(callbacks.enabled).toBe(true);
  });

  /**
   * A watch refused under the old groups is one the renewed credentials may
   * be allowed. Fails if a renewal does not subscribe it again, or if a watch
   * refused a second time is subscribed on every visit after it.
   */
  it("subscribes a refused watch again on renewed credentials, and stops again when those are refused", () => {
    const refusal =
      'ApiError: daemonsets.apps is forbidden: User "marco" cannot watch resource "daemonsets"';
    watched();
    act(() => callbacks.onError?.(refusal));
    expect(callbacks.enabled).toBe(false);

    act(() => credentialsRenewed());
    expect(callbacks.enabled).toBe(true);

    act(() => callbacks.onError?.(refusal));
    expect(callbacks.enabled).toBe(false);
  });

  /** Fails if a recovered watch keeps the list polling, or a second failure after it is not noticed. */
  it("stops polling when the watch recovers, and polls again at the next failure", () => {
    const { result } = watched();
    act(() => callbacks.onError?.("gone"));
    act(() => callbacks.onRecovered?.());
    expect(result.current).toMatchObject({ live: true, refresh: false });
    act(() => callbacks.onError?.("gone again"));
    expect(result.current).toMatchObject({
      live: false,
      refresh: "resourceList",
    });
  });

  /** A list no watch can run for is polled, and must not read as live. */
  it("is not live where no watch can run", () => {
    const { result } = watched(false);
    expect(result.current).toMatchObject({
      live: false,
      refresh: "resourceList",
    });
  });

  /**
   * A new scope is a new stream. The failure of the last one was held by the
   * hook, and only a recovery of the stream that failed could clear it, so a
   * healthy list kept polling and said it was not live.
   */
  it("starts a new scope's stream without the last scope's failure", () => {
    const { result, rerender } = renderHook(
      ({ queryKey }) =>
        useWatchedList({
          enabled: true,
          subscribe: () => Promise.resolve("stream"),
          queryKey,
          detail: POD_DETAIL,
        }),
      { initialProps: { queryKey: ["pods", "a,b"] } }
    );
    act(() => callbacks.onError?.("default: connection reset"));
    expect(result.current.live).toBe(false);
    rerender({ queryKey: ["pods", "c"] });
    expect(result.current).toMatchObject({ live: true, refresh: false });
    act(() => callbacks.onError?.("c: connection reset"));
    expect(result.current.live).toBe(false);
  });

  /**
   * The Gateway routes report their own failures, and a refusal reported
   * that way was never kept: every visit subscribed the refused watch again.
   * Fails if such a watch is subscribed again on the connection that
   * refused it.
   */
  it("does not subscribe again a refused watch whose caller reports it itself", () => {
    const report = vi.fn();
    const first = watched(true, report);
    act(() =>
      callbacks.onError?.(
        'ApiError: httproutes.gateway.networking.k8s.io is forbidden: User "marco" cannot watch resource "httproutes"'
      )
    );
    expect(report).toHaveBeenCalledTimes(1);
    first.unmount();
    const { result } = watched(true, report);
    expect(callbacks.enabled).toBe(false);
    expect(result.current.live).toBe(false);
  });

  it("hands the failure to a caller that reports it itself", () => {
    const report = vi.fn();
    watched(true, report);
    act(() => callbacks.onError?.("refused"));
    expect(report).toHaveBeenCalledWith("refused");
    expect(toast).not.toHaveBeenCalled();
  });

  /**
   * Marco's Deployments page carried the green live badge while its sidebar
   * count said it was polled. Fails if a live list that recounts is not
   * reported followed, or a failed one, one that does not recount, or one no
   * page holds any more still is.
   */
  it("reports a list followed only while a live watch that recounts feeds it", () => {
    const follows = renderHook(() => useListFollowed(["pods"]));
    const page = watched();
    follows.rerender();
    expect(follows.result.current).toBe(true);

    act(() => callbacks.onError?.("watch stream failed: connection reset"));
    follows.rerender();
    expect(follows.result.current).toBe(false);
    page.unmount();

    const quiet = renderHook(() =>
      useWatchedList({
        enabled: true,
        subscribe: () => Promise.resolve("stream"),
        queryKey: ["pods"],
        detail: POD_DETAIL,
        recount: false,
      })
    );
    follows.rerender();
    expect(follows.result.current).toBe(false);
    quiet.unmount();

    const again = watched();
    follows.rerender();
    expect(follows.result.current).toBe(true);
    again.unmount();
    follows.rerender();
    expect(follows.result.current).toBe(false);
  });

  /**
   * The Events page was live while its sidebar row said it was polled: its
   * watch recounts nothing, so nothing knew a watch fed it. Fails if a live
   * watch that does not recount is not reported live, or a failed one or one
   * no page holds still is.
   */
  it("reports a list live while any live watch feeds it, recounting or not", () => {
    const live = renderHook(() => useListLive(["events", null, "watch"]));
    const page = renderHook(() =>
      useWatchedList({
        enabled: true,
        subscribe: () => Promise.resolve("stream"),
        queryKey: ["events", null, "watch"],
        detail: () => [],
        recount: false,
      })
    );
    live.rerender();
    expect(live.result.current).toBe(true);

    act(() => callbacks.onError?.("watch stream failed: connection reset"));
    live.rerender();
    expect(live.result.current).toBe(false);
    page.unmount();
    live.rerender();
    expect(live.result.current).toBe(false);
  });
});
