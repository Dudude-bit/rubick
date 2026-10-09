import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import type { ReactNode } from "react";

vi.mock("@/lib/commands", () => ({
  commands: {
    subscribeObjectWatch: vi.fn(async () => "object-stream"),
    resourceWatchSubscribed: vi.fn(async () => undefined),
    unsubscribeResourceWatch: vi.fn(async () => undefined),
  },
}));

import { commands } from "@/lib/commands";
import { queryKeys } from "@/lib/query-keys";
import { useClusterStore } from "@/stores/clusterStore";
import { useWindowActivity } from "@/lib/window-activity";
import { testQueryClient } from "@/test/render";
import { useObjectWatch } from "./useObjectWatch";

const SERVICE = { name: "big-pull", namespace: "shop" };

let dispatch: ((event: { payload: unknown }) => void) | null = null;

function send(...changes: Array<{ op: string; resource?: unknown }>) {
  dispatch?.({
    payload: {
      channel: "resource-event",
      stream_id: "object-stream",
      changes: changes.map((change) => ({ resource: null, ...change })),
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

function mount(gone: boolean, kind = "Service") {
  const client = testQueryClient();
  const getService = vi.fn(async () => SERVICE);
  renderHook(
    () => {
      useObjectWatch(kind, SERVICE.namespace, SERVICE.name, gone);
      return useQuery({
        queryKey: queryKeys.detail(kind, SERVICE.namespace, SERVICE.name),
        queryFn: getService,
        staleTime: Infinity,
      }).data;
    },
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    }
  );
  return getService;
}

/**
 * Sam's Service page, opened before big-pull existed, still said it was
 * gone 8 s after it was created. Fails if a gone page's name is not
 * watched, or the page is not read again once something appears under it.
 */
it("reads a gone page's object again the moment it is created under that name", async () => {
  const getService = mount(true);
  await waitFor(() =>
    expect(commands.resourceWatchSubscribed).toHaveBeenCalledWith(
      "object-stream"
    )
  );
  expect(commands.subscribeObjectWatch).toHaveBeenCalledWith(
    "Service",
    SERVICE.namespace,
    SERVICE.name
  );
  await waitFor(() => expect(getService).toHaveBeenCalledTimes(1));

  send({ op: "restarted" }, { op: "synced" });
  send({ op: "applied", resource: SERVICE });

  await waitFor(() => expect(getService).toHaveBeenCalledTimes(2));
});

/** Fails if an object already there when the watch starts, listed rather than announced, is not read again. */
it("reads it again when the watch finds it already there", async () => {
  const getService = mount(true);
  await waitFor(() =>
    expect(commands.resourceWatchSubscribed).toHaveBeenCalled()
  );
  await waitFor(() => expect(getService).toHaveBeenCalledTimes(1));

  send(
    { op: "restarted" },
    { op: "applied", resource: SERVICE },
    { op: "synced" }
  );

  await waitFor(() => expect(getService).toHaveBeenCalledTimes(2));
});

/**
 * Sam's big-pull page kept the deleted Service, ClusterIP and all, for 25 s
 * on a read that had backed off. Fails if a page holding its object does not
 * watch it, or the watch seeing it deleted does not read the page again.
 */
it("reads a page's object again the moment the watch sees it deleted", async () => {
  const getService = mount(false);
  await waitFor(() =>
    expect(commands.resourceWatchSubscribed).toHaveBeenCalledWith(
      "object-stream"
    )
  );
  await waitFor(() => expect(getService).toHaveBeenCalledTimes(1));
  send(
    { op: "restarted" },
    { op: "applied", resource: SERVICE },
    { op: "synced" }
  );

  send({ op: "deleted", resource: SERVICE });

  await waitFor(() => expect(getService).toHaveBeenCalledTimes(2));
});

/** Fails if a page holding an object the watch lists nothing under, deleted before it began, is not read again. */
it("reads a page's object again when the watch finds nothing under its name", async () => {
  const getService = mount(false);
  await waitFor(() =>
    expect(commands.resourceWatchSubscribed).toHaveBeenCalled()
  );
  await waitFor(() => expect(getService).toHaveBeenCalledTimes(1));

  send({ op: "restarted" }, { op: "synced" });

  await waitFor(() => expect(getService).toHaveBeenCalledTimes(2));
});

/** Fails if a kind nothing watches by name opens a stream. */
it("watches nothing for a kind with no watch by name", async () => {
  const unwatched = mount(true, "ConfigMap");
  await waitFor(() => expect(unwatched).toHaveBeenCalled());
  expect(commands.subscribeObjectWatch).not.toHaveBeenCalled();
});
