import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import type { ReactNode } from "react";

vi.mock("@/lib/commands", () => ({
  commands: {
    subscribeObjectWatch: vi.fn(async () => "pod-stream"),
    subscribeOwnedPodWatch: vi.fn(async () => "pod-stream"),
    resourceWatchSubscribed: vi.fn(async () => undefined),
    unsubscribeResourceWatch: vi.fn(async () => undefined),
  },
}));

import { commands } from "@/lib/commands";
import { queryKeys } from "@/lib/query-keys";
import { useClusterStore } from "@/stores/clusterStore";
import { SurfaceVisibility } from "@/lib/surface-visibility";
import { useWindowActivity } from "@/lib/window-activity";
import { testQueryClient } from "@/test/render";
import { useOwnedPodsWatch, usePodWatch } from "./usePodWatch";

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

const OWNED = queryKeys.ownedPods("Deployment", "shop", "checkout");

function mountOwned({
  kind = "Deployment",
  visible = true,
  uid = "first",
}: { kind?: string; visible?: boolean; uid?: string | null } = {}) {
  const client = testQueryClient();
  if (uid)
    client.setQueryData(queryKeys.detail(kind, "shop", "checkout"), { uid });
  const listPods = vi
    .fn()
    .mockResolvedValueOnce([{ ...POD, display: "CrashLoopBackOff" }])
    .mockResolvedValue([{ ...POD, display: "Running" }]);
  const hook = renderHook(
    () => {
      useOwnedPodsWatch(kind, "shop", "checkout", [OWNED], true);
      return useQuery({
        queryKey: OWNED,
        queryFn: listPods,
        staleTime: Infinity,
      }).data;
    },
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>
          <SurfaceVisibility.Provider value={visible}>
            {children}
          </SurfaceVisibility.Provider>
        </QueryClientProvider>
      ),
    }
  );
  return { hook, listPods, client };
}

/**
 * Sam watched the Deployment's Pods tab say CrashLoopBackOff through every
 * Running window while the Pods list turned: the tab only polled. Fails if
 * the watch on the Deployment's pods seeing one change does not read the
 * tab's rows again.
 */
it("reads a workload's pods again when the watch on them sees one change", async () => {
  const { hook, listPods } = mountOwned();
  await waitFor(() =>
    expect(commands.resourceWatchSubscribed).toHaveBeenCalledWith("pod-stream")
  );
  expect(commands.subscribeOwnedPodWatch).toHaveBeenCalledWith(
    "Deployment",
    "shop",
    "checkout"
  );
  await waitFor(() =>
    expect(hook.result.current).toMatchObject([{ display: "CrashLoopBackOff" }])
  );

  send("applied", { ...POD, phase: "Running" });

  await waitFor(() =>
    expect(hook.result.current).toMatchObject([{ display: "Running" }])
  );
  expect(listPods).toHaveBeenCalledTimes(2);
});

/** A node's pods are in every namespace. Fails if the node's watch is asked for one. */
it("asks for a node's pods in no namespace", async () => {
  mountOwned({ kind: "Node" });
  await waitFor(() =>
    expect(commands.subscribeOwnedPodWatch).toHaveBeenCalledWith(
      "Node",
      null,
      "checkout"
    )
  );
});

/** Fails if a peek or tab kept mounted off screen holds a stream open for nobody. */
it("opens no stream for a surface off screen", async () => {
  const { hook } = mountOwned({ visible: false });
  await waitFor(() => expect(hook.result.current).toBeDefined());
  expect(commands.subscribeOwnedPodWatch).not.toHaveBeenCalled();
});

/**
 * The Deployment header kept "Unavailable 0/2 ready, polled 25s ago" beside
 * a row saying 1/1 ready: the watch read the pods again and not the object
 * whose counts its controller rewrote on the same change. Fails if a pod
 * change leaves the workload's own object to its poll.
 */
it("reads the workload's own object again when one of its pods changes", async () => {
  const client = testQueryClient();
  const getDeployment = vi
    .fn()
    .mockResolvedValueOnce({ uid: "first", ready: 0 })
    .mockResolvedValue({ uid: "first", ready: 1 });
  const hook = renderHook(
    () => {
      useOwnedPodsWatch("Deployment", "shop", "checkout", [OWNED], true);
      return useQuery({
        queryKey: queryKeys.detail("Deployment", "shop", "checkout"),
        queryFn: getDeployment,
        staleTime: Infinity,
      }).data;
    },
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    }
  );
  await waitFor(() =>
    expect(commands.resourceWatchSubscribed).toHaveBeenCalledWith("pod-stream")
  );
  await waitFor(() =>
    expect(hook.result.current).toEqual({ uid: "first", ready: 0 })
  );

  send("applied", { ...POD, phase: "Running" });

  await waitFor(() =>
    expect(hook.result.current).toEqual({ uid: "first", ready: 1 })
  );
  expect(getDeployment).toHaveBeenCalledTimes(2);
});

/**
 * Sam opened big-pull's page while the Deployment did not exist and applied
 * it: the watch on its pods, refused at subscribe, never came back, and the
 * Pods tab polled. Fails if a workload made again under its name keeps the
 * stream of the one before it, or if one is asked for before it is read.
 */
it("watches the pods of the object read, and again when it is made again", async () => {
  const { client } = mountOwned({ uid: null });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(commands.subscribeOwnedPodWatch).not.toHaveBeenCalled();

  client.setQueryData(queryKeys.detail("Deployment", "shop", "checkout"), {
    uid: "first",
  });
  await waitFor(() =>
    expect(commands.subscribeOwnedPodWatch).toHaveBeenCalledTimes(1)
  );

  client.setQueryData(queryKeys.detail("Deployment", "shop", "checkout"), {
    uid: "second",
  });
  await waitFor(() =>
    expect(commands.subscribeOwnedPodWatch).toHaveBeenCalledTimes(2)
  );
  expect(commands.unsubscribeResourceWatch).toHaveBeenCalled();
});
