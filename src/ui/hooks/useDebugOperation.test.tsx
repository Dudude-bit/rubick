import { act, renderHook } from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

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
    debugPodCopy: vi.fn().mockResolvedValue({
      id: "op-copy",
      podName: "web-debug-1",
      namespace: "shop",
      containerName: "debugger-1",
      operationType: "CopyPod",
      createdAt: 0,
      timeoutSeconds: 120,
    }),
    cancelDebugOperation: vi.fn().mockResolvedValue(null),
    getDebugStatus: vi
      .fn()
      .mockResolvedValue({ type: "pending", reason: "ContainerCreating" }),
  },
}));

import { useWindowActivity } from "@/lib/window-activity";
import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import { debugFailureWords, useDebugOperation } from "./useDebugOperation";

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
        traceProcesses: false,
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

  /**
   * The clock reads whole seconds and the start was kept to the millisecond,
   * so a wait begun half a second past one read 0 a full second in, and
   * stayed a second behind. Fails if the start is not read the same way.
   */
  it("counts a second once one has passed, however far into a second it began", async () => {
    vi.setSystemTime(Date.parse("2026-09-23T12:00:00.500Z"));
    const { result } = renderHook(() =>
      useDebugOperation({
        onReady: vi.fn(),
        onError: vi.fn(),
        onTimeout: vi.fn(),
      })
    );
    await act(async () => {
      await result.current.startEphemeral("web", "shop", {} as never);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(result.current.elapsedSeconds).toBe(1);
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

describe("a debug pod nobody is waiting for any more", () => {
  const waiting = () =>
    renderHook(() =>
      useDebugOperation({
        onReady: vi.fn(),
        onError: vi.fn(),
        onTimeout: vi.fn(),
      })
    );

  /**
   * Leaving the page mid-wait cleared the timer and nothing else: the copy
   * ran the workload a second time for its hour with no one told its name.
   * Fails if unmounting while waiting does not cancel the operation.
   */
  it("is cancelled when the dialog goes away while still waiting", async () => {
    const { commands } = await import("@/lib/commands");
    vi.mocked(commands.cancelDebugOperation).mockClear();
    const { result, unmount } = waiting();
    await act(async () => {
      await result.current.startCopyPod("web", "shop", {} as never);
    });
    expect(commands.cancelDebugOperation).not.toHaveBeenCalled();

    unmount();

    expect(commands.cancelDebugOperation).toHaveBeenCalledWith("op-copy");
  });

  /** A session that became ready is the reader's to keep: leaving its page must not delete the pod under their shell. */
  it("is left alone once the debugger is ready", async () => {
    const { commands } = await import("@/lib/commands");
    vi.mocked(commands.cancelDebugOperation).mockClear();
    vi.mocked(commands.getDebugStatus).mockResolvedValueOnce({
      type: "ready",
      result: {
        podName: "web-debug-1",
        containerName: "debugger-1",
        namespace: "shop",
        isNewPod: true,
        seesRootOf: null,
      },
    });
    const { result, unmount } = waiting();
    await act(async () => {
      await result.current.startCopyPod("web", "shop", {} as never);
    });

    unmount();

    expect(commands.cancelDebugOperation).not.toHaveBeenCalled();
  });

  /** The create was still in flight when the dialog went: the operation it returns has nobody to poll it, so it is cancelled on arrival. */
  it("is cancelled on arrival when its create outlived the dialog", async () => {
    const { commands } = await import("@/lib/commands");
    vi.mocked(commands.cancelDebugOperation).mockClear();
    let arrive: (op: never) => void = () => {};
    vi.mocked(commands.debugPodCopy).mockReturnValueOnce(
      new Promise((resolve) => (arrive = resolve))
    );
    const { result, unmount } = waiting();
    let started: Promise<void> = Promise.resolve();
    act(() => {
      started = result.current.startCopyPod("web", "shop", {} as never);
    });
    unmount();
    arrive({ id: "op-late" } as never);
    await started;

    expect(commands.cancelDebugOperation).toHaveBeenCalledWith("op-late");
    expect(commands.getDebugStatus).not.toHaveBeenCalledWith("op-late");
  });
});

describe("what a failed debug session says of the pod it made", () => {
  const en: T = (section, key, values) => translate("en", section, key, values);

  /** "Container terminated: Completed" and a copy left running was all the reader got; the pod's fate is the other half of the answer. */
  it("says the pod was deleted, or names the one still there", () => {
    expect(
      debugFailureWords(
        "Container terminated: Completed",
        { name: "web-debug-1", deleted: true },
        en
      )
    ).toBe("Container terminated: Completed. Its pod web-debug-1 was deleted.");
    expect(
      debugFailureWords("x", { name: "web-debug-1", deleted: false }, en)
    ).toBe(
      "x. Its pod web-debug-1 could not be deleted and is still in the cluster: delete it from its page."
    );
    expect(debugFailureWords("x", null, en)).toBe("x");
  });

  /** The failed status carries the pod; dropped on the way to the dialog, the toast is the old one. */
  it("hands the dialog the pod with the error", async () => {
    const { commands } = await import("@/lib/commands");
    const pod = { name: "web-debug-1", deleted: true };
    vi.mocked(commands.getDebugStatus).mockResolvedValueOnce({
      type: "failed",
      error: "Container terminated: Completed",
      pod,
    });
    const onError = vi.fn();
    const { result } = renderHook(() =>
      useDebugOperation({ onReady: vi.fn(), onError, onTimeout: vi.fn() })
    );
    await act(async () => {
      await result.current.startCopyPod("web", "shop", {} as never);
    });

    expect(onError).toHaveBeenCalledWith(
      "Container terminated: Completed",
      pod
    );
  });
});
