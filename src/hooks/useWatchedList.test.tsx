import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

const toast = vi.fn();
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast }) }));

let callbacks: { onError?: (m: string) => void; onRecovered?: () => void } = {};
vi.mock("@/hooks/useResourceWatch", () => ({
  useResourceWatch: (options: typeof callbacks) => {
    callbacks = options;
    return { resyncing: false };
  },
}));

import { useWatchedList } from "./useWatchedList";

const watched = (
  enabled = true,
  reportFailure: string | ((m: string) => void) = "Pods"
) =>
  renderHook(() =>
    useWatchedList({
      enabled,
      subscribe: () => Promise.resolve("stream"),
      queryKey: ["pods"],
      reportFailure,
    })
  );

describe("a list kept current by a watch", () => {
  beforeEach(() => toast.mockClear());

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
      callbacks.onError?.("watch is forbidden");
      callbacks.onError?.("watch is forbidden");
    });
    expect(result.current).toMatchObject({
      live: false,
      refresh: "resourceList",
      watchFailed: true,
    });
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast.mock.calls[0][0].description).toContain("watch is forbidden");
  });

  it("stops polling when the watch recovers, and speaks up at the next failure", () => {
    const { result } = watched();
    act(() => callbacks.onError?.("gone"));
    act(() => callbacks.onRecovered?.());
    expect(result.current).toMatchObject({ live: true, refresh: false });
    act(() => callbacks.onError?.("gone again"));
    expect(toast).toHaveBeenCalledTimes(2);
  });

  /** Several namespaces are polled, never watched, and must not read as live. */
  it("is not live where no watch can run", () => {
    const { result } = watched(false);
    expect(result.current).toMatchObject({
      live: false,
      refresh: "resourceList",
    });
  });

  it("hands the failure to a caller that reports it itself", () => {
    const report = vi.fn();
    watched(true, report);
    act(() => callbacks.onError?.("refused"));
    expect(report).toHaveBeenCalledWith("refused");
    expect(toast).not.toHaveBeenCalled();
  });
});
