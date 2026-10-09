import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { render, screen, waitFor } from "@testing-library/react";
import {
  QueryClientProvider,
  useQuery,
  type QueryClient,
} from "@tanstack/react-query";
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
import { useChainAnswer } from "@/hooks/useChainAnswer";
import { queryKeys } from "@/lib/query-keys";
import { useWindowActivity } from "@/lib/window-activity";
import { useClusterStore } from "@/stores/clusterStore";
import { testQueryClient } from "@/test/render";
import { ChainWatches } from "./ChainWatches";

const DEPLOYMENT: ObjectRef = {
  kind: "Deployment",
  name: "big-pull",
  namespace: "shop",
  existence: "present",
  facts: null,
};

const SERVICE: ObjectRef = {
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
  more: Partial<ResourceConnections>
): ResourceConnections {
  return {
    subject: DEPLOYMENT,
    edges: [],
    stops: stop ? [stop] : [],
    published: [
      {
        service: SERVICE,
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

const NO_POD = (more: Partial<ResourceConnections>) =>
  answer(
    { ready: 0, notReady: 0 },
    {
      reason: "selectsNothing",
      service: SERVICE,
      selector: "app=big-pull",
      near: null,
    },
    more
  );
const COMING_UP = (more: Partial<ResourceConnections>) =>
  answer(
    { ready: 0, notReady: 1 },
    {
      reason: "noneReady",
      service: SERVICE,
      selector: "app=big-pull",
      pods: 1,
      why: "comingUp",
    },
    more
  );
const READY = (more: Partial<ResourceConnections>) =>
  answer({ ready: 1, notReady: 0 }, null, more);

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

const POD = { name: "big-pull-67577558d6-5s4hz", namespace: "shop" };
const SLICE = { name: "big-pull-x8f2k", namespace: "shop" };
const DETAIL = queryKeys.detail("Deployment", "shop", "big-pull");
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

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
  client.setQueryData(DETAIL, { uid: "big-pull-uid" });
});

afterEach(() => {
  useClusterStore.setState({ isConnected: false, currentContext: null });
});

/** The Deployment page's chain as its "How traffic gets here" block reads it. */
function Chain() {
  const chain = useChainAnswer("Deployment", "big-pull", "shop");
  const { data, isPending } = chain.read;
  const stop = data?.published[0]?.stop;
  return (
    <>
      <ChainWatches services={chain.services} reads={[chain.key]} />
      <p>
        {isPending
          ? "following the path in"
          : stop
            ? stop.reason
            : data
              ? "reaches a ready pod"
              : "no answer"}
      </p>
    </>
  );
}

function draw() {
  render(
    <QueryClientProvider client={client}>
      <Chain />
    </QueryClientProvider>
  );
}

/**
 * Sam's da1: the Deployment page drew red "No pod carries app=big-pull" for
 * 8.2 s beside a header reading Ready 1/1, from a read nothing asked again
 * until a poll. Fails if a read that found no pod is drawn before the pods
 * of the Service in front are listed, or once they list one, or if it is not
 * read again.
 */
it("draws no 'No pod carries' on a Deployment's chain from a read older than the pod the Service's watch lists", async () => {
  commands.getResourceConnections
    .mockResolvedValueOnce(
      NO_POD({ subjectUid: "big-pull-uid", readAt: ago(5_000) })
    )
    .mockResolvedValue(
      COMING_UP({ subjectUid: "big-pull-uid", readAt: ago(0) })
    );
  draw();
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
  expect(screen.getByText("following the path in")).toBeInTheDocument();
  expect(screen.queryByText("selectsNothing")).toBeNull();

  send(
    "pods-stream",
    { op: "restarted" },
    { op: "applied", resource: POD },
    { op: "synced" }
  );

  expect(await screen.findByText("noneReady")).toBeInTheDocument();
  expect(screen.queryByText("selectsNothing")).toBeNull();
});

/**
 * Sam's dc1 and ud1: blue "1 pod carries app=big-pull, and it is not ready"
 * for 8.3 s under a header reading Ready 1/1. Fails if the slices of the
 * Service in front of a Deployment are not watched, or a change they see
 * does not read its chain again.
 */
it("reads a Deployment's chain again when a slice of the Service in front of it changes", async () => {
  commands.getResourceConnections
    .mockResolvedValueOnce(
      COMING_UP({ subjectUid: "big-pull-uid", readAt: ago(1_000) })
    )
    .mockResolvedValue(READY({ subjectUid: "big-pull-uid", readAt: ago(0) }));
  draw();
  expect(await screen.findByText("noneReady")).toBeInTheDocument();
  await waitFor(() =>
    expect(commands.resourceWatchSubscribed).toHaveBeenCalledWith(
      "slices-stream"
    )
  );
  expect(commands.subscribeServiceSliceWatch).toHaveBeenCalledWith(
    "shop",
    "big-pull"
  );

  send("slices-stream", { op: "applied", resource: SLICE });

  expect(await screen.findByText("reaches a ready pod")).toBeInTheDocument();
  expect(commands.getResourceConnections).toHaveBeenCalledTimes(2);
});

/**
 * Sam's db1: deleted and applied again, the page drew the old Deployment's
 * pod as "1 published" for 20 s. Fails if an answer naming another uid than
 * the Deployment the page read is drawn, or is not read again.
 */
it("draws no chain from an earlier Deployment of the same name, and reads again", async () => {
  let release: (value: ResourceConnections) => void = () => {};
  commands.getResourceConnections
    .mockResolvedValueOnce(READY({ subjectUid: "first", readAt: ago(30_000) }))
    .mockReturnValueOnce(
      new Promise<ResourceConnections>((resolve) => (release = resolve))
    );
  draw();

  await waitFor(() =>
    expect(commands.getResourceConnections).toHaveBeenCalledTimes(2)
  );
  expect(screen.getByText("following the path in")).toBeInTheDocument();
  expect(screen.queryByText("reaches a ready pod")).toBeNull();

  release(COMING_UP({ subjectUid: "big-pull-uid", readAt: ago(0) }));
  expect(await screen.findByText("noneReady")).toBeInTheDocument();
});

/**
 * An Ingress page draws its header's verdict from the Services list's
 * answer, not from its chain, and kept "backend coming up" there once the
 * chain had moved on. Fails if a change under the chain does not read every
 * answer the page hands the watches.
 */
it("reads every answer it is handed again when a slice under the chain changes", async () => {
  const header = ["service-health-inputs", "shop"];
  const read = vi.fn(async () => ({ rows: [], unread: [] }));
  function Header() {
    useQuery({ queryKey: header, queryFn: read });
    return null;
  }
  render(
    <QueryClientProvider client={client}>
      <Header />
      <ChainWatches
        services={[
          { namespace: "shop", name: "big-pull", selector: "app=big-pull" },
        ]}
        reads={[header]}
      />
    </QueryClientProvider>
  );
  await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
  await waitFor(() =>
    expect(commands.resourceWatchSubscribed).toHaveBeenCalledWith(
      "slices-stream"
    )
  );

  send("slices-stream", { op: "applied", resource: SLICE });

  await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
});
