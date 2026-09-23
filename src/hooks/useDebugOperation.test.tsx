import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/commands", () => ({
  commands: {
    debugPodEphemeral: vi.fn().mockResolvedValue({
      id: "op-1",
      podName: "web",
      namespace: "shop",
      containerName: "debugger-1",
      operationType: "Ephemeral",
      createdAt: 0,
      timeoutSeconds: 120,
    }),
    getDebugStatus: vi
      .fn()
      .mockResolvedValue({ type: "pending", reason: "ContainerCreating" }),
  },
}));

import { useWindowActivity } from "@/lib/window-activity";
import { useDebugOperation } from "./useDebugOperation";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse("2026-09-23T12:00:00Z"));
  useWindowActivity.setState({ visible: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("how long a debug container has been awaited", () => {
  /**
   * The count was one tick of a one-second interval. A hidden window
   * throttles timers, so after ten real seconds the dialog could say "1s"
   * against a two-minute timeout.
   */
  it("reads the clock rather than counting ticks", async () => {
    const { result } = renderHook(() =>
      useDebugOperation({
        onReady: vi.fn(),
        onError: vi.fn(),
        onTimeout: vi.fn(),
      })
    );
    await act(async () => {
      await result.current.startEphemeral("web", "shop", {
        image: "busybox",
        targetContainer: null,
        command: null,
        shareProcesses: false,
        timeoutSeconds: null,
      } as never);
    });
    expect(result.current.elapsedSeconds).toBe(0);

    vi.setSystemTime(Date.now() + 10_000);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(result.current.elapsedSeconds).toBe(11);
  });
});

describe("a debug container the cluster refused", () => {
  /** `String(err)` handed the dialog "Error: Tauri command 'debugPodEphemeral' failed: …", and the toast showed all of it. Fails if the error is stringified by hand again. */
  it("gives the dialog the server's words without the command in front", async () => {
    const { commands } = await import("@/lib/commands");
    vi.mocked(commands.debugPodEphemeral).mockRejectedValueOnce(
      new Error(
        "Tauri command 'debugPodEphemeral' failed: pods \"web\" is forbidden"
      )
    );
    const onError = vi.fn();
    const { result } = renderHook(() =>
      useDebugOperation({ onReady: vi.fn(), onError, onTimeout: vi.fn() })
    );
    await act(async () => {
      await result.current.startEphemeral("web", "shop", {} as never);
    });

    expect(onError).toHaveBeenCalledWith('pods "web" is forbidden');
  });
});
