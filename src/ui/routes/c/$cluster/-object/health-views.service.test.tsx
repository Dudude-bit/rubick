import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";

const commands = vi.hoisted(() => ({
  getResourceConnections: vi.fn(),
  detectGatewayApi: vi.fn(async () => ({
    installed: false,
    bundleVersion: null,
    channel: null,
    mixedBundle: false,
    kinds: [],
  })),
  subscribeOwnedPodWatch: vi.fn(async () => "pods-stream"),
  subscribeServiceSliceWatch: vi.fn(async () => "slices-stream"),
  resourceWatchSubscribed: vi.fn(async () => undefined),
  unsubscribeResourceWatch: vi.fn(async () => undefined),
}));
vi.mock("@/lib/commands", () => ({ commands }));

import type {
  ChainStop,
  ObjectRef,
  ResourceConnections,
} from "@/generated/types";
import { queryKeys } from "@/lib/query-keys";
import { useClusterStore } from "@/stores/clusterStore";
import { useWindowActivity } from "@/lib/window-activity";
import { testQueryClient } from "@/test/render";
import { ServiceHealthView } from "./health-views";

const SUBJECT: ObjectRef = {
  kind: "Service",
  name: "big-pull",
  namespace: "shop",
  existence: "present",
  facts: {
    kind: "service",
    type: "ClusterIP",
    clusterIp: "10.43.0.9",
    externalName: null,
    selector: "app=big-pull",
    ports: [],
  },
};

function answer(
  counts: { ready: number; notReady: number },
  stop: ChainStop | null,
  more: Partial<ResourceConnections> = {}
): ResourceConnections {
  return {
    subject: SUBJECT,
    edges: [],
    stops: stop ? [stop] : [],
    published: [
      {
        service: SUBJECT,
        source: "slices",
        slices: 1,
        ready: counts.ready,
        draining: 0,
        notReady: counts.notReady,
        unrouted: 0,
        unroutedReady: 0,
        ports: [],
        endpoints: [],
        whole: true,
        unpublished: [],
        stop,
      },
    ],
    notLookedAt: [],
    ...more,
  };
}

const READY = (more: Partial<ResourceConnections> = {}) =>
  answer({ ready: 1, notReady: 0 }, null, more);
const COMING_UP = (more: Partial<ResourceConnections> = {}) =>
  answer(
    { ready: 0, notReady: 1 },
    {
      reason: "noneReady",
      service: SUBJECT,
      selector: "app=big-pull",
      pods: 1,
      why: "comingUp",
    },
    more
  );
const NO_POD = (more: Partial<ResourceConnections> = {}) =>
  answer(
    { ready: 0, notReady: 0 },
    {
      reason: "selectsNothing",
      service: SUBJECT,
      selector: "app=big-pull",
      near: null,
    },
    more
  );

let handlers: Array<(event: { payload: unknown }) => void> = [];

function send(
  stream: string,
  ...changes: Array<{ op: string; resource?: unknown }>
) {
  for (const handler of handlers)
    handler({
      payload: {
        channel: "resource-event",
        stream_id: stream,
        changes: changes.map((change) => ({ resource: null, ...change })),
        error: null,
      },
    });
}

const POD = { name: "big-pull-6d9f7-x2", namespace: "shop" };

let client: QueryClient;

beforeEach(() => {
  vi.clearAllMocks();
  commands.getResourceConnections.mockReset();
  handlers = [];
  vi.mocked(listen).mockImplementation(async (event, handler) => {
    if (event === "resource-event")
      handlers.push(handler as (event: { payload: unknown }) => void);
    return () => {};
  });
  useClusterStore.setState({ isConnected: true, currentContext: "k3d-rubick" });
  useWindowActivity.setState({ visible: true });
  client = testQueryClient();
});

afterEach(() => {
  useClusterStore.setState({ isConnected: false, currentContext: null });
});

function draw() {
  render(
    <QueryClientProvider client={client}>
      <ServiceHealthView name="big-pull" namespace="shop" />
    </QueryClientProvider>
  );
}

const streamsOpen = () =>
  waitFor(() =>
    expect(commands.resourceWatchSubscribed).toHaveBeenCalledWith(
      "slices-stream"
    )
  );

/**
 * Sam's big-pull page painted "1 ready" for a third of a second from the
 * Service deleted before it under the same name, while kubectl had the new
 * one's pod at 0/1. Fails if an answer naming another uid than the Service
 * read is drawn, or is not read again.
 */
it("draws no verdict from an earlier Service of the same name, and reads again", async () => {
  client.setQueryData(queryKeys.detail("Service", "shop", "big-pull"), {
    uid: "second",
  });
  let release: (value: ResourceConnections) => void = () => {};
  commands.getResourceConnections
    .mockResolvedValueOnce(READY({ subjectUid: "first" }))
    .mockReturnValueOnce(
      new Promise<ResourceConnections>((resolve) => (release = resolve))
    );
  draw();

  await waitFor(() =>
    expect(commands.getResourceConnections).toHaveBeenCalledTimes(2)
  );
  expect(screen.getByText("still reading")).toBeInTheDocument();
  expect(screen.queryByText("1 ready")).toBeNull();

  release(COMING_UP({ subjectUid: "second" }));
  expect(await screen.findByText("coming up")).toBeInTheDocument();
});

/**
 * The same page said red "No pod carries app=big-pull" for seconds while
 * kubectl had the pod in ContainerCreating: the lists were read before the
 * pod was made. Fails if a read older than the pod the Service's own watch
 * has seen is drawn, or is not read again; and if a read newer than the
 * watch is held back.
 */
it("holds back a read older than the pod its watch has seen, and reads again", async () => {
  const before = new Date(Date.now() - 5_000).toISOString();
  commands.getResourceConnections
    .mockResolvedValueOnce(NO_POD({ readAt: before }))
    .mockResolvedValueOnce(COMING_UP({ readAt: new Date().toISOString() }));
  draw();
  expect(await screen.findByText("no endpoints")).toBeInTheDocument();
  await waitFor(() =>
    expect(commands.subscribeOwnedPodWatch).toHaveBeenCalledWith(
      "Service",
      "shop",
      "big-pull"
    )
  );
  await waitFor(() =>
    expect(commands.resourceWatchSubscribed).toHaveBeenCalledWith("pods-stream")
  );

  send(
    "pods-stream",
    { op: "restarted" },
    { op: "applied", resource: POD },
    { op: "synced" }
  );

  expect(await screen.findByText("still reading")).toBeInTheDocument();
  expect(screen.queryByText("no endpoints")).toBeNull();
  expect(await screen.findByText("coming up")).toBeInTheDocument();

  commands.getResourceConnections.mockResolvedValue(
    NO_POD({ readAt: new Date(Date.now() + 1_000).toISOString() })
  );
  await client.invalidateQueries({ queryKey: ["connections"] });
  expect(await screen.findByText("no endpoints")).toBeInTheDocument();
});

/**
 * Sam's page kept "coming up" and "Endpoints 0" for 7 s after the pod was
 * Ready, on a poll that had slowed. Fails if the Service's slices are not
 * watched, or a change the watch sees does not read the verdict again.
 */
it("reads the verdict again when the Service's slices change", async () => {
  commands.getResourceConnections
    .mockResolvedValueOnce(COMING_UP())
    .mockResolvedValue(READY());
  draw();
  expect(await screen.findByText("coming up")).toBeInTheDocument();
  await streamsOpen();
  expect(commands.subscribeServiceSliceWatch).toHaveBeenCalledWith(
    "shop",
    "big-pull"
  );

  send("slices-stream", {
    op: "applied",
    resource: { name: "big-pull-x8f2k", namespace: "shop" },
  });

  expect(await screen.findByText("1 ready")).toBeInTheDocument();
  expect(commands.getResourceConnections).toHaveBeenCalledTimes(2);
});

/**
 * A read refused with NotFound keeps the last answer in the cache, and the
 * badge drew it: a deleted Service still "1 ready". Fails if a Service the
 * cluster says is gone keeps the verdict of the last answer.
 */
it("draws no verdict for a Service the cluster says is gone", async () => {
  commands.getResourceConnections
    .mockResolvedValueOnce(READY())
    .mockRejectedValue({
      code: "NOT_FOUND",
      message: 'services "big-pull" not found',
    });
  draw();
  expect(await screen.findByText("1 ready")).toBeInTheDocument();

  await client.invalidateQueries({ queryKey: ["connections"] });

  await waitFor(() => expect(screen.queryByText("1 ready")).toBeNull());
});

const NOT_FOUND = {
  code: "NOT_FOUND",
  message: "Resource not found: Service/big-pull in namespace shop",
};

/**
 * Sam's page showed "not checked / Resource not found: Service/big-pull"
 * for half a second beside the ClusterIP of the Service it had just read:
 * the neighbourhood was asked before the Service was created. Fails if a
 * NotFound older than the page's own read of the Service is drawn, or the
 * neighbourhood is not read again at once.
 */
it("reads a NotFound older than the Service its page holds as still reading, and reads again", async () => {
  let release: (value: ResourceConnections) => void = () => {};
  commands.getResourceConnections
    .mockRejectedValueOnce(NOT_FOUND)
    .mockReturnValueOnce(
      new Promise<ResourceConnections>((resolve) => (release = resolve))
    );
  draw();
  expect(await screen.findByText("not checked")).toBeInTheDocument();

  client.setQueryData(queryKeys.detail("Service", "shop", "big-pull"), {
    uid: "big-pull-uid",
  });

  expect(await screen.findByText("still reading")).toBeInTheDocument();
  expect(screen.queryByText("not checked")).toBeNull();
  await waitFor(() =>
    expect(commands.getResourceConnections).toHaveBeenCalledTimes(2)
  );
  release(COMING_UP());
  expect(await screen.findByText("coming up")).toBeInTheDocument();
  expect(commands.getResourceConnections).toHaveBeenCalledTimes(2);
});

/**
 * After kubectl delete the same page kept the old Service beside "Resource
 * not found" for 25 s. Fails if a NotFound newer than the page's read is
 * drawn as a verdict, or does not send the page to read its Service again.
 */
it("reads a NotFound newer than the Service its page holds as still reading, and asks the page to look again", async () => {
  const detail = queryKeys.detail("Service", "shop", "big-pull");
  client.setQueryData(detail, { uid: "big-pull-uid" });
  commands.getResourceConnections
    .mockResolvedValueOnce(READY())
    .mockRejectedValue(NOT_FOUND);
  draw();
  expect(await screen.findByText("1 ready")).toBeInTheDocument();

  await client.invalidateQueries({ queryKey: ["connections"] });

  expect(await screen.findByText("still reading")).toBeInTheDocument();
  expect(screen.queryByText("not checked")).toBeNull();
  await waitFor(() =>
    expect(client.getQueryState(detail)?.isInvalidated).toBe(true)
  );
});
