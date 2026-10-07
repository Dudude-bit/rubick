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

import { queryKeys } from "@/lib/query-keys";
import { useClusterStore } from "@/stores/clusterStore";
import { useWatchedList } from "./useWatchedList";

const POD_DETAIL = queryKeys.rowDetail("Pod");

const watched = (
  enabled = true,
  reportFailure: string | ((m: string) => void) = "Pods"
) =>
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
   * A refused watch left the list frozen, claiming to be live. Nine copies
   * of the fallback each did this in their own way; a burst of failures must
   * still say so once.
   */
  it("polls and says so once when the watch fails", () => {
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
    expect(toast).toHaveBeenCalledTimes(1);
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

  /** Fails if the cluster's own words reach the toast again. */
  it("says the fallback in the app's words, not the cluster's", () => {
    watched();
    act(() =>
      callbacks.onError?.(
        "watch stream failed: ApiError: too old resource version: Expired"
      )
    );
    const { description } = toast.mock.calls[0][0];
    expect(description).toBe("Pods: falling back to periodic refresh.");
  });

  it("stops polling when the watch recovers, and speaks up at the next failure", () => {
    const { result } = watched();
    act(() => callbacks.onError?.("gone"));
    act(() => callbacks.onRecovered?.());
    expect(result.current).toMatchObject({ live: true, refresh: false });
    act(() => callbacks.onError?.("gone again"));
    expect(toast).toHaveBeenCalledTimes(2);
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
          reportFailure: "Pods",
        }),
      { initialProps: { queryKey: ["pods", "a,b"] } }
    );
    act(() => callbacks.onError?.("default: connection reset"));
    expect(result.current.live).toBe(false);
    rerender({ queryKey: ["pods", "c"] });
    expect(result.current).toMatchObject({ live: true, refresh: false });
    act(() => callbacks.onError?.("c: connection reset"));
    expect(toast).toHaveBeenCalledTimes(2);
  });

  it("hands the failure to a caller that reports it itself", () => {
    const report = vi.fn();
    watched(true, report);
    act(() => callbacks.onError?.("refused"));
    expect(report).toHaveBeenCalledWith("refused");
    expect(toast).not.toHaveBeenCalled();
  });
});
