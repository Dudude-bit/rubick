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
