import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";

const commands = vi.hoisted(() => ({
  listServiceBacking: vi.fn(),
  subscribeOwnedPodWatch: vi.fn(async () => "pods-stream"),
  subscribeServiceSliceWatch: vi.fn(async () => "slices-stream"),
  resourceWatchSubscribed: vi.fn(async () => undefined),
  unsubscribeResourceWatch: vi.fn(async () => undefined),
}));
vi.mock("@/lib/commands", () => ({ commands }));

import type {
  ChainStop,
  ObjectRef,
  RouteInfo,
  ServiceBacking,
  ServiceInfo,
} from "@/generated/types";
import { backingOf } from "@/integrations";
import { useWindowActivity } from "@/lib/window-activity";
import { useClusterStore } from "@/stores/clusterStore";
import { testQueryClient } from "@/test/render";
import { ChainWatches } from "../../../-object/ChainWatches";
import { useRouteBacking } from "./useRouteBacking";

const ROUTE = {
  kind: "HTTPRoute",
  name: "shop",
  namespace: "shop",
  rules: [
    {
      backendRefs: [
        {
          group: "",
          kind: "Service",
          name: "web",
          namespace: null,
          port: 80,
          weight: null,
        },
      ],
    },
  ],
} as unknown as RouteInfo;

const SERVICE: ObjectRef = {
  kind: "Service",
  name: "web",
  namespace: "shop",
  existence: "present",
  facts: null,
};

function lists(
  ready: number,
  stop: ChainStop | null,
  readAt: string
): ServiceBacking {
  return {
    services: [
      { name: "web", namespace: "shop", selector: { app: "web" } },
    ] as unknown as ServiceInfo[],
    published: [
      {
        service: SERVICE,
        source: "slices",
        slices: 1,
        ready,
        draining: 0,
        notReady: 0,
        unrouted: 0,
        unroutedReady: 0,
        ports: [],
        endpoints: [],
        whole: true,
        unpublished: [],
        stop,
      },
    ],
    readAt,
  };
}

const UNPUBLISHED: ChainStop = {
  reason: "publishesNothing",
  service: SERVICE,
  selector: "app=web",
  pods: 1,
  readyPods: 1,
  unnamedPorts: [],
};

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

let client: QueryClient;

beforeEach(() => {
  vi.clearAllMocks();
  commands.listServiceBacking.mockReset();
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

/** The route page's "Behind it" cell for its one backend. */
function Behind() {
  const backing = useRouteBacking(ROUTE, true);
  const state = backingOf(
    { name: "web", namespace: "shop" },
    { kind: "HTTPRoute", name: "shop", namespace: "shop" },
    backing.sources
  );
  return (
    <>
      <ChainWatches services={backing.services} reads={[backing.key]} />
      <p>
        {!state.known
          ? "reading"
          : state.stop
            ? state.stop.reason
            : `${state.ready} ready`}
      </p>
    </>
  );
}

/**
 * A route page read its backends from cluster-wide lists a minute stale by
 * design, so a backend that had just gained its address stayed "publishes
 * no endpoint" there while its Service's page said ready. Fails if the
 * backend's slices are not watched under the route, or a fault read whose
 * lists were asked before a slice changed is drawn, or not read again.
 */
it("holds a backend's fault read older than a change to its slices, and reads again", async () => {
  commands.listServiceBacking
    .mockResolvedValueOnce(
      lists(0, UNPUBLISHED, new Date(Date.now() - 5_000).toISOString())
    )
    .mockResolvedValue(
      lists(1, null, new Date(Date.now() + 60_000).toISOString())
    );
  render(
    <QueryClientProvider client={client}>
      <Behind />
    </QueryClientProvider>
  );
  expect(await screen.findByText("publishesNothing")).toBeInTheDocument();
  await waitFor(() =>
    expect(commands.resourceWatchSubscribed).toHaveBeenCalledWith(
      "slices-stream"
    )
  );
  expect(commands.subscribeServiceSliceWatch).toHaveBeenCalledWith(
    "shop",
    "web"
  );

  send("slices-stream", {
    op: "applied",
    resource: { name: "web-x8f2k", namespace: "shop" },
  });

  expect(await screen.findByText("reading")).toBeInTheDocument();
  expect(await screen.findByText("1 ready")).toBeInTheDocument();
  expect(commands.listServiceBacking).toHaveBeenCalledTimes(2);
});
