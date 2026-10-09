import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import type { ReactNode } from "react";

vi.mock("@/lib/commands", () => ({
  commands: {
    subscribeObjectWatch: vi.fn(async () => "pod-stream"),
    resourceWatchSubscribed: vi.fn(async () => undefined),
    unsubscribeResourceWatch: vi.fn(async () => undefined),
  },
}));

import { commands } from "@/lib/commands";
import { queryKeys } from "@/lib/query-keys";
import { useClusterStore } from "@/stores/clusterStore";
import { useWindowActivity } from "@/lib/window-activity";
import { testQueryClient } from "@/test/render";
import { usePodWatch } from "./usePodWatch";

const POD = { name: "checkout-55cbfdc66-nnbgp", namespace: "shop" };

let dispatch: ((event: { payload: unknown }) => void) | null = null;

function send(op: string, resource: unknown) {
  dispatch?.({
    payload: {
      channel: "resource-event",
      stream_id: "pod-stream",
      changes: [{ op, resource }],
      error: null,
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  dispatch = null;
  vi.mocked(listen).mockImplementation(async (event, handler) => {
    if (event === "resource-event") dispatch = handler as typeof dispatch;
    return () => {};
  });
  useClusterStore.setState({ isConnected: true });
  useWindowActivity.setState({ visible: true });
});

afterEach(() => {
  useClusterStore.setState({ isConnected: false });
});

function mount(enabled = true) {
  const client = testQueryClient();
  const getPod = vi
    .fn()
    .mockResolvedValueOnce({ ...POD, phase: "CrashLoopBackOff" })
    .mockResolvedValue({ ...POD, phase: "Running" });
  const hook = renderHook(
    () => {
      usePodWatch(POD.namespace, POD.name, enabled);
      return useQuery({
        queryKey: queryKeys.detail("Pod", POD.namespace, POD.name),
        queryFn: getPod,
        staleTime: Infinity,
      }).data;
    },
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    }
  );
  return { hook, getPod };
}

/**
 * Sam's pod page read CrashLoopBackOff two seconds after kubectl said
 * Running: no list's watch runs under a page, and its poll had backed off.
 * Fails if the pod's own watch seeing it change does not read it again.
 */
it("reads the pod again when its own watch sees it change, with no poll behind it", async () => {
  const { hook, getPod } = mount();
  await waitFor(() =>
    expect(commands.resourceWatchSubscribed).toHaveBeenCalledWith("pod-stream")
  );
  expect(commands.subscribeObjectWatch).toHaveBeenCalledWith(
    "Pod",
    POD.namespace,
    POD.name
  );
  await waitFor(() =>
    expect(hook.result.current).toMatchObject({ phase: "CrashLoopBackOff" })
  );

  send("applied", { ...POD, phase: "Running" });

  await waitFor(() =>
    expect(hook.result.current).toMatchObject({ phase: "Running" })
  );
  expect(getPod).toHaveBeenCalledTimes(2);
});

/** Fails if a page that turned the watch off, or a pod already gone, still holds a stream open. */
it("opens no stream while it is turned off", async () => {
  const { hook } = mount(false);
  await waitFor(() => expect(hook.result.current).toBeDefined());
  expect(commands.subscribeObjectWatch).not.toHaveBeenCalled();
});
