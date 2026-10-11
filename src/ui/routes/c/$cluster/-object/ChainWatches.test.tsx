import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { act, render, screen, waitFor } from "@testing-library/react";
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

/**
 * Sam's d1: the chain named the draining pod for a second after the new one
 * was published, from a re-read that shared a backend read begun before the
 * slice changed. Fails if the re-read a slice change asks for does not tell
 * the backend to join no read begun before that change.
 */
it("asks the backend for no read begun before the slice the watch saw change", async () => {
  const DRAINING = answer({ ready: 0, notReady: 0 }, null, {
    subjectUid: "big-pull-uid",
  });
  DRAINING.published[0].draining = 1;
  let changedAt = 0;
  commands.getResourceConnections.mockImplementation(
    async (...args: unknown[]) => {
      const notBefore = args[4] as string | null;
      const readAt = new Date().toISOString();
      return changedAt && notBefore && Date.parse(notBefore) >= changedAt
        ? READY({ subjectUid: "big-pull-uid", readAt })
        : { ...DRAINING, readAt };
    }
  );
  function Served() {
    const chain = useChainAnswer("Deployment", "big-pull", "shop");
    const published = chain.read.data?.published[0];
    return (
      <>
        <ChainWatches services={chain.services} reads={[chain.key]} />
        <p>
          {published
            ? `${published.ready} ready, ${published.draining} draining`
            : "following the path in"}
        </p>
      </>
    );
  }
  render(
    <QueryClientProvider client={client}>
      <Served />
    </QueryClientProvider>
  );
  expect(await screen.findByText("0 ready, 1 draining")).toBeInTheDocument();
  await waitFor(() =>
    expect(commands.resourceWatchSubscribed).toHaveBeenCalledWith(
      "slices-stream"
    )
  );

  changedAt = Date.now();
  send("slices-stream", { op: "applied", resource: SLICE });

  expect(await screen.findByText("1 ready, 0 draining")).toBeInTheDocument();
});

/**
 * Sam's round 22: published at .312, the header Ready by .7, the chain still
 * naming the draining pod at 1.0 s. The path from the slice's watch event to
 * the chain drawn, with a backend that shares a read begun in the last 250 ms
 * the way `Snapshots` does and takes 150 ms to read, and a read already in
 * flight when the slice changes. Fails if the chain lands later than 500 ms
 * after the event.
 */
it("draws the new pod on a Deployment's chain within half a second of its slice changing", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
  try {
    const READ_MS = 150;
    const SHARED_MS = 250;
    let published = false;
    let flight: {
      start: number;
      landed: number | null;
      answer: Promise<ResourceConnections>;
    } | null = null;
    const DRAINING = answer({ ready: 0, notReady: 0 }, null, {
      subjectUid: "big-pull-uid",
    });
    DRAINING.published[0].draining = 1;
    commands.getResourceConnections.mockImplementation((...args: unknown[]) => {
      const notBefore = args[4] as string | null;
      const now = Date.now();
      const joinable =
        flight &&
        (flight.landed === null || now - flight.start < SHARED_MS) &&
        (!notBefore || flight.start >= Date.parse(notBefore));
      if (joinable) return flight!.answer;
      const start = now;
      const state = published;
      const next = {
        start,
        landed: null as number | null,
        answer: new Promise<ResourceConnections>((resolve) =>
          setTimeout(() => {
            next.landed = Date.now();
            const readAt = new Date(start).toISOString();
            resolve(
              state
                ? READY({ subjectUid: "big-pull-uid", readAt })
                : { ...DRAINING, readAt }
            );
          }, READ_MS)
        ),
      };
      flight = next;
      return next.answer;
    });
    function Served() {
      const chain = useChainAnswer("Deployment", "big-pull", "shop");
      const row = chain.read.data?.published[0];
      return (
        <>
          <ChainWatches services={chain.services} reads={[chain.key]} />
          <p>{row ? `${row.ready} ready, ${row.draining} draining` : "…"}</p>
        </>
      );
    }
    render(
      <QueryClientProvider client={client}>
        <Served />
      </QueryClientProvider>
    );
    const step = () => act(() => vi.advanceTimersByTimeAsync(10));
    for (let i = 0; i < 100 && !screen.queryByText("0 ready, 1 draining"); i++)
      await step();
    expect(screen.getByText("0 ready, 1 draining")).toBeInTheDocument();
    for (
      let i = 0;
      i < 100 && commands.resourceWatchSubscribed.mock.calls.length < 2;
      i++
    )
      await step();
    send(
      "pods-stream",
      { op: "restarted" },
      { op: "applied", resource: POD },
      { op: "synced" }
    );
    for (let i = 0; i < 100; i++) await step();

    const before = flight;
    send("pods-stream", { op: "applied", resource: POD });
    for (
      let i = 0;
      i < 100 && (flight === before || Date.now() - flight!.start < 50);
      i++
    )
      await step();
    expect(flight!.landed).toBeNull();

    published = true;
    const changed = Date.now();
    send("slices-stream", { op: "applied", resource: SLICE });
    while (
      !screen.queryByText("1 ready, 0 draining") &&
      Date.now() - changed < 3000
    )
      await step();
    expect(Date.now() - changed).toBeLessThanOrEqual(500);
  } finally {
    vi.useRealTimers();
  }
});
