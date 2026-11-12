import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

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
  commands: { listPortForwards: vi.fn(async () => []) },
}));

const toast = vi.fn();
vi.mock("@/components/ui/use-toast", () => ({
  useToast: () => ({ toast }),
}));

import { commands } from "@/lib/commands";
import { usePortForwardStore } from "@/stores/portForwardStore";
import { useClusterStore } from "@/stores/clusterStore";
import { usePortForwardEvents } from "./usePortForwardEvents";

const session = {
  id: "pf-9",
  context: "prod",
  pod: "payments",
  namespace: "shop",
  localPort: 8080,
  remotePort: 80,
  autoReconnect: false,
  createdAt: "2026-09-23T10:00:00Z",
  via: { kind: "pod" as const },
};

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(listeners)) delete listeners[key];
  usePortForwardStore.setState({ sessions: [session] });
});

describe("the forwards list when the event bridge falls behind", () => {
  /** A lag can drop a forward's `stopped`, and the panel went on listing a forward that had died, with a Stop button over nothing. Fails if the lag does not ask the backend again. */
  it("asks the backend again and drops a forward it no longer has", async () => {
    const hook = renderHook(() => usePortForwardEvents());
    await act(async () => {});

    await act(async () => {
      for (const handler of listeners["event-bridge-lagged"] ?? []) {
        handler({ payload: { missed: 1200 } });
      }
    });

    expect(commands.listPortForwards).toHaveBeenCalled();
    expect(usePortForwardStore.getState().sessions).toEqual([]);
    hook.unmount();
  });
});

const emit = (payload: Record<string, unknown>) =>
  act(async () => {
    for (const handler of listeners["port-forward-status"] ?? []) {
      handler({
        payload: {
          channel: "port-forward-status",
          id: "pf-9",
          namespace: "shop",
          local_port: 8080,
          remote_port: 80,
          attempt: null,
          note: null,
          ...payload,
        },
      });
    }
  });

describe("a forward the backend moved or ended", () => {
  /** After a restart the Activity row kept naming a pod that was gone. */
  it("follows the forward to the pod it moved to", async () => {
    const hook = renderHook(() => usePortForwardEvents());
    await act(async () => {});
    await emit({
      pod: "payments-55f",
      status: "moved",
      note: { says: "moved", from: "payments" },
    });
    expect(usePortForwardStore.getState().sessions[0].pod).toBe("payments-55f");
    hook.unmount();
  });

  /** An ended forward keeps its reason on screen rather than vanishing. */
  it("keeps an ended forward with its reason", async () => {
    usePortForwardStore.setState({ failed: [] });
    const hook = renderHook(() => usePortForwardEvents());
    await act(async () => {});
    await emit({
      pod: "payments",
      status: "failed",
      note: { says: "podGone", pod: "payments" },
    });
    expect(usePortForwardStore.getState().failed).toEqual([
      { session, note: { says: "podGone", pod: "payments" } },
    ]);
    hook.unmount();
  });
});

describe("a toast about a forward", () => {
  const said = () => toast.mock.calls.map(([each]) => each.description);

  /**
   * The event names no cluster and the forward outlives the move to another
   * one. Fails if the toast drops the name: on staging it then reads as
   * staging's pod `payments`.
   */
  it("names the cluster of a forward the window is no longer on", async () => {
    useClusterStore.setState({ currentContext: "staging" });
    const hook = renderHook(() => usePortForwardEvents());
    await act(async () => {});
    await emit({ pod: "payments", status: "reconnecting" });
    expect(said()).toEqual(["prod · localhost:8080 → payments:80"]);
    hook.unmount();
  });

  /** The name is spent only where it tells two clusters apart. Fails if every toast carries it. */
  it("names no cluster for a forward of the cluster on screen", async () => {
    useClusterStore.setState({ currentContext: "prod" });
    const hook = renderHook(() => usePortForwardEvents());
    await act(async () => {});
    await emit({ pod: "payments", status: "reconnecting" });
    expect(said()).toEqual(["localhost:8080 → payments:80"]);
    hook.unmount();
  });
});
