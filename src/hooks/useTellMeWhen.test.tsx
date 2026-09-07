import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DeploymentInfo } from "@/generated/types";
import { LOST_SIGHT_MS, type Watch } from "@/lib/tell-me-when";
import { useClusterStore } from "@/stores/clusterStore";
import { useTellMeWhenStore } from "@/stores/tellMeWhenStore";

const listeners: Record<
  string,
  Array<(event: { payload: unknown }) => void> | undefined
> = {};

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(
    async (event: string, handler: (e: { payload: unknown }) => void) => {
      (listeners[event] ??= []).push(handler);
      return () => {
        listeners[event] = listeners[event]?.filter((h) => h !== handler);
      };
    }
  ),
}));

vi.mock("@/lib/commands", () => ({
  commands: {
    subscribeObjectWatch: vi.fn(async () => "stream-1"),
    subscribeCustomObjectWatch: vi.fn(async () => "stream-2"),
    resourceWatchSubscribed: vi.fn(async () => undefined),
    unsubscribeResourceWatch: vi.fn(async () => undefined),
  },
}));

const notifyMock = vi.fn(async (_notice: unknown) => "delivered" as const);
vi.mock("@/lib/notify", () => ({
  notify: (notice: unknown) => notifyMock(notice),
}));

vi.mock("@/components/ui/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

import { commands } from "@/lib/commands";
import { useTellMeWhen } from "./useTellMeWhen";

function emit(event: string, payload: unknown) {
  for (const handler of listeners[event] ?? []) handler({ payload });
}

function deployment(updated: number, reason?: string): DeploymentInfo {
  return {
    replicas: { desired: 3, ready: 3, available: 3, updated },
    conditions: reason
      ? [
          {
            type: "Progressing",
            status: "True",
            reason,
            message: null,
            lastTransitionTime: null,
          },
        ]
      : [],
  } as DeploymentInfo;
}

// Started now, not at epoch: a day-old question expires on the first tick.
const rollout = (): Watch => ({
  id: "w-rollout",
  context: "prod",
  kind: "Deployment",
  namespace: "shop",
  name: "payments",
  ask: "rollout",
  startedAt: Date.now(),
  status: { state: "watching" },
  baseline: null,
});

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.clearAllMocks();
  for (const key of Object.keys(listeners)) delete listeners[key];
  useTellMeWhenStore.setState({ watches: [] });
  useClusterStore.setState({ currentContext: "prod", isConnected: true });
});

afterEach(() => {
  vi.useRealTimers();
});

async function armed() {
  const hook = renderHook(() => useTellMeWhen());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  await waitFor(() =>
    expect(commands.resourceWatchSubscribed).toHaveBeenCalledWith("stream-1")
  );
  return hook;
}

describe("a rollout being watched", () => {
  /** Twenty-two watch events are one rollout; a notification per event is the alerting this feature exists to not be. */
  it("gives exactly one notification for a rollout of twenty-two events", async () => {
    useTellMeWhenStore.setState({ watches: [rollout()] });
    const hook = await armed();

    const looks = [
      deployment(1),
      ...Array.from({ length: 20 }, (_, i) => deployment(1 + (i % 3))),
      deployment(3, "NewReplicaSetAvailable"),
    ];
    for (const look of looks) {
      act(() =>
        emit("resource-event", {
          stream_id: "stream-1",
          changes: [{ op: "applied", resource: look }],
          error: null,
        })
      );
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock).toHaveBeenCalledWith({
      title: "payments rolled out",
      body: "",
    });
    const watch = useTellMeWhenStore.getState().watches[0];
    expect(watch.status.state).toBe("done");
    expect(commands.unsubscribeResourceWatch).toHaveBeenCalledWith("stream-1");
    hook.unmount();
  });

  /** A stream that dropped and never came back would otherwise leave the row reading "watching" for a day. */
  it("reports losing sight after two minutes without the stream, and not before", async () => {
    useTellMeWhenStore.setState({ watches: [rollout()] });
    const hook = await armed();

    act(() =>
      emit("resource-event", {
        stream_id: "stream-1",
        changes: [{ op: "failed", resource: null }],
        error: "watch: connection reset",
      })
    );
    expect(useTellMeWhenStore.getState().watches[0].status.state).toBe("lost");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LOST_SIGHT_MS - 1_000);
    });
    expect(notifyMock).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000 + 10_000);
    });
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock).toHaveBeenCalledWith({
      title: "Lost sight of payments",
      body: "",
    });
    hook.unmount();
  });

  it("goes back to watching when the stream recovers inside the two minutes", async () => {
    useTellMeWhenStore.setState({ watches: [rollout()] });
    const hook = await armed();

    act(() =>
      emit("resource-event", {
        stream_id: "stream-1",
        changes: [{ op: "failed", resource: null }],
        error: "watch: connection reset",
      })
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    act(() =>
      emit("resource-event", {
        stream_id: "stream-1",
        changes: [{ op: "applied", resource: deployment(1) }],
        error: null,
      })
    );
    expect(useTellMeWhenStore.getState().watches[0].status.state).toBe(
      "watching"
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LOST_SIGHT_MS + 10_000);
    });
    expect(notifyMock).not.toHaveBeenCalled();
    hook.unmount();
  });
});

describe("questions the cluster does not answer through a watch", () => {
  it("answers a drain from the drain's own ending", async () => {
    useTellMeWhenStore.setState({
      watches: [
        {
          ...rollout(),
          id: "w-drain",
          kind: "Node",
          namespace: null,
          name: "node-7",
          ask: "drain",
        },
      ],
    });
    const hook = renderHook(() => useTellMeWhen());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    act(() =>
      emit("drain-finished", {
        drain_id: "d1",
        node: "node-7",
        outcome: "failed",
        report: {},
        message: "pod shop/payments-0 would not be evicted",
      })
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(notifyMock).toHaveBeenCalledWith({
      title: "node-7 drain did not finish",
      body: "pod shop/payments-0 would not be evicted",
    });
    expect(commands.subscribeObjectWatch).not.toHaveBeenCalled();
    hook.unmount();
  });

  it("answers a port forward from its status event", async () => {
    useTellMeWhenStore.setState({
      watches: [
        {
          ...rollout(),
          id: "w-fwd",
          kind: "PortForward",
          ask: "forwardAlive",
          sessionId: "pf-9",
        },
      ],
    });
    const hook = renderHook(() => useTellMeWhen());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    act(() =>
      emit("port-forward-status", {
        id: "pf-9",
        pod: "payments",
        namespace: "shop",
        local_port: 8080,
        remote_port: 80,
        status: "error",
        message: "connection refused",
      })
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(notifyMock).toHaveBeenCalledWith({
      title: "Forward to payments died",
      body: "connection refused",
    });
    hook.unmount();
  });
});
