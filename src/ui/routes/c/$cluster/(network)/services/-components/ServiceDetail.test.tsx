import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import type { ResourceConnections, ServiceInfo } from "@/generated/types";
import { useClusterStore } from "@/stores/clusterStore";
import { useWindowActivity } from "@/lib/window-activity";
import { renderWithRouter } from "@/test/render";
import { ServiceDetail } from "./ServiceDetail";

const SERVICE: ServiceInfo = {
  name: "big-pull",
  namespace: "shop",
  uid: "big-pull-uid",
  type: "ClusterIP",
  sessionAffinity: "None",
  clusterIp: "10.43.0.9",
  externalName: null,
  externalIps: [],
  loadBalancerIps: [],
  ports: [
    {
      name: null,
      port: 80,
      targetPort: "8080",
      protocol: "TCP",
      nodePort: null,
    },
  ],
  selector: { app: "big-pull" },
  labels: {},
  annotations: {},
  createdAt: null,
};

const neighbourhood = (ready: number): ResourceConnections => {
  const subject = {
    kind: "Service",
    name: "big-pull",
    namespace: "shop",
    existence: "present" as const,
    facts: {
      kind: "service" as const,
      type: "ClusterIP",
      clusterIp: "10.43.0.9",
      externalName: null,
      selector: "app=big-pull",
      ports: [],
    },
  };
  return {
    subject,
    subjectUid: "big-pull-uid",
    edges: [],
    stops: [],
    published: [
      {
        service: subject,
        source: "slices",
        slices: 1,
        ready,
        draining: 0,
        notReady: 1 - ready,
        unrouted: 0,
        unroutedReady: 0,
        ports: [],
        endpoints: [],
        whole: true,
        unpublished: [],
        stop: null,
      },
    ],
    notLookedAt: [],
  };
};

let handlers: Array<(event: { payload: unknown }) => void> = [];
let reads = 0;

beforeEach(() => {
  handlers = [];
  reads = 0;
  vi.mocked(listen).mockImplementation(async (event, handler) => {
    if (event === "resource-event")
      handlers.push(handler as (event: { payload: unknown }) => void);
    return () => {};
  });
  vi.mocked(invoke).mockImplementation(async (command: string) => {
    if (command === "get_service") return SERVICE;
    if (command === "get_resource_connections")
      return neighbourhood(reads++ === 0 ? 0 : 1);
    if (command === "subscribe_owned_pod_watch") return "pods-stream";
    if (command === "subscribe_service_slice_watch") return "slices-stream";
    return undefined;
  });
  useClusterStore.setState({ currentContext: "k3d-rubick", isConnected: true });
  useWindowActivity.setState({ visible: true, focused: true });
});

afterEach(() => {
  vi.mocked(invoke).mockImplementation(async () => undefined);
  useClusterStore.setState({ currentContext: null, isConnected: false });
});

/**
 * Sam's big-pull page kept "Endpoints 0" for 7 s after its pod was Ready,
 * on a poll that had slowed. Fails if the page stops following the
 * Service's slices on a tab without its status badge, or a change they see
 * leaves the Endpoints tab to the poll.
 */
it("follows the Service's slices on every tab, and turns Endpoints with them", async () => {
  await renderWithRouter(<ServiceDetail />, {
    at: "/c/k3d-rubick/services/shop/big-pull?tab=endpoints",
    route: "/c/$cluster/services/$namespace/$name",
  });
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("subscribe_service_slice_watch", {
      namespace: "shop",
      name: "big-pull",
    })
  );
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("resource_watch_subscribed", {
      streamId: "slices-stream",
    })
  );
  const tab = screen.getByRole("tab", { name: /^Endpoints/ });
  expect(tab).toHaveTextContent("1");
  const before = reads;

  for (const handler of handlers)
    handler({
      payload: {
        channel: "resource-event",
        stream_id: "slices-stream",
        changes: [
          {
            op: "applied",
            resource: { name: "big-pull-x8f2k", namespace: "shop" },
          },
        ],
        error: null,
      },
    });

  await waitFor(() => expect(reads).toBe(before + 1));
  expect(invoke).toHaveBeenCalledWith("subscribe_owned_pod_watch", {
    kind: "Service",
    namespace: "shop",
    name: "big-pull",
  });
});

const noPodYet = (readAt: string): ResourceConnections => {
  const answer = neighbourhood(0);
  const stop = {
    reason: "selectsNothing" as const,
    service: answer.subject,
    selector: "app=big-pull",
    near: null,
  };
  return {
    ...answer,
    readAt,
    stops: [stop],
    published: [{ ...answer.published[0], notReady: 0, stop }],
  };
};

function sendTo(
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

/**
 * Sam's big-pull page drew red "No pod carries app=big-pull" in its trace
 * for up to 0.66 s while its Status row beside it said "still reading" and
 * kubectl already had the pod. Fails if the trace, or any other reader on
 * the page, draws a verdict from an answer the Status holds back.
 */
it("draws no verdict anywhere on the page while its Status is still reading", async () => {
  let release: (value: ResourceConnections) => void = () => {};
  let asked = 0;
  vi.mocked(invoke).mockImplementation(async (command: string) => {
    if (command === "get_service") return SERVICE;
    if (command === "get_resource_connections")
      return asked++ === 0
        ? noPodYet(new Date(Date.now() - 5_000).toISOString())
        : new Promise<ResourceConnections>((resolve) => (release = resolve));
    if (command === "subscribe_owned_pod_watch") return "pods-stream";
    if (command === "subscribe_service_slice_watch") return "slices-stream";
    return undefined;
  });
  await renderWithRouter(<ServiceDetail />, {
    at: "/c/k3d-rubick/services/shop/big-pull",
    route: "/c/$cluster/services/$namespace/$name",
  });
  expect(await screen.findAllByText(/No pod carries/)).toHaveLength(2);
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("resource_watch_subscribed", {
      streamId: "pods-stream",
    })
  );

  sendTo(
    "pods-stream",
    { op: "restarted" },
    {
      op: "applied",
      resource: { name: "big-pull-6d9f7-x2", namespace: "shop" },
    },
    { op: "synced" }
  );

  expect(await screen.findByText("still reading")).toBeInTheDocument();
  expect(screen.queryByText(/No pod carries/)).toBeNull();
  expect(screen.queryByText("no endpoints")).toBeNull();
  await waitFor(() => expect(asked).toBe(2));

  release({ ...neighbourhood(1), readAt: new Date().toISOString() });
  expect(await screen.findByText("1 ready")).toBeInTheDocument();
});

/**
 * After kubectl delete, Sam's page kept big-pull, ClusterIP and tabs, for
 * 25 s on a read that had backed off. Fails if the page does not watch its
 * Service, or does not say it is gone the moment the watch sees it deleted.
 */
it("says the Service no longer exists the moment its watch sees it deleted", async () => {
  let deleted = false;
  vi.mocked(invoke).mockImplementation(async (command: string) => {
    if (command === "get_service") {
      if (deleted)
        throw { code: "NOT_FOUND", message: 'services "big-pull" not found' };
      return SERVICE;
    }
    if (command === "get_resource_connections") return neighbourhood(1);
    if (command === "subscribe_object_watch") return "object-stream";
    if (command === "subscribe_owned_pod_watch") return "pods-stream";
    if (command === "subscribe_service_slice_watch") return "slices-stream";
    return undefined;
  });
  await renderWithRouter(<ServiceDetail />, {
    at: "/c/k3d-rubick/services/shop/big-pull",
    route: "/c/$cluster/services/$namespace/$name",
  });
  expect(await screen.findByText("1 ready")).toBeInTheDocument();
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("resource_watch_subscribed", {
      streamId: "object-stream",
    })
  );
  sendTo(
    "object-stream",
    { op: "restarted" },
    { op: "applied", resource: SERVICE },
    { op: "synced" }
  );

  deleted = true;
  sendTo("object-stream", { op: "deleted", resource: SERVICE });

  expect(
    await screen.findByText("This Service no longer exists.")
  ).toBeInTheDocument();
});
