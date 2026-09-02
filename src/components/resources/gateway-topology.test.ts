import { describe, expect, it } from "vitest";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";

/** The tests read the English catalogue — the same strings as before. */
const t = ((section, key, values) =>
  translate("en", section, key, values)) as T;

import { gatewayTopology } from "./gateway-topology";
import type {
  ConditionInfo,
  GatewayInfo,
  RouteInfo,
  RouteParentStatusInfo,
} from "@/generated/types";

const condition = (
  type: string,
  status: string,
  reason: string | null = null
): ConditionInfo => ({
  type,
  status,
  reason,
  message: null,
  lastTransitionTime: null,
});

const gateway = (
  name: string,
  conditions: ConditionInfo[] = []
): GatewayInfo => ({
  name,
  namespace: "gwtest",
  apiVersion: "gateway.networking.k8s.io/v1",
  className: "envoy",
  listenerSets: [],
  listenerSetsKnown: true,
  listeners: [],
  addresses: ["203.0.113.9"],
  conditions,
  generation: null,
  labels: {},
  annotations: {},
  createdAt: null,
});

const parentStatus = (
  gatewayName: string,
  conditions: ConditionInfo[]
): RouteParentStatusInfo => ({
  parent: {
    group: "gateway.networking.k8s.io",
    kind: "Gateway",
    name: gatewayName,
    namespace: null,
    sectionName: null,
    port: null,
  },
  controllerName: "example.net/gw",
  conditions,
});

const route = (
  name: string,
  overrides: Partial<RouteInfo> = {}
): RouteInfo => ({
  kind: "HTTPRoute",
  apiVersion: "gateway.networking.k8s.io/v1",
  name,
  namespace: "gwtest",
  hostnames: [`${name}.example.com`],
  parentRefs: [
    {
      group: "gateway.networking.k8s.io",
      kind: "Gateway",
      name: "edge",
      namespace: null,
      sectionName: null,
      port: null,
    },
  ],
  rules: [
    {
      matches: [],
      backendRefs: [
        {
          group: "",
          kind: "Service",
          name,
          namespace: null,
          port: 8080,
          weight: null,
        },
      ],
      hasRedirect: false,
      extensionRefs: [],
    },
  ],
  parents: [],
  generation: null,
  labels: {},
  annotations: {},
  createdAt: null,
  ...overrides,
});

describe("the gateway topology map", () => {
  /** `Unknown` is the API's third answer and it was painting the node red —
   *  the opposite lie to the green one the trace told about the same
   *  condition. `routeTone` in the same file has always drawn the
   *  distinction; `gatewayTone` did not. */
  it("does not paint a gateway red while its controller is still deciding", () => {
    const data = gatewayTopology(
      [gateway("edge", [condition("Programmed", "Unknown", "Pending")])],
      [],
      undefined,
      t
    );
    const gateways = data.columns.find((c) => c.label === "Gateways");

    expect(gateways?.nodes[0].tone).toBe("mute");
  });

  /** And a controller that said False still gets red — deleting the whole
   *  branch would pass the test above. */
  it("still paints a gateway red when its controller refused it", () => {
    const data = gatewayTopology(
      [gateway("edge", [condition("Programmed", "False", "Invalid")])],
      [],
      undefined,
      t
    );
    const gateways = data.columns.find((c) => c.label === "Gateways");

    expect(gateways?.nodes[0].tone).toBe("err");
  });

  it("draws gateway, route and backend as three linked columns", () => {
    const data = gatewayTopology(
      [gateway("edge", [condition("Programmed", "True", "Programmed")])],
      [
        route("promo", {
          parents: [
            parentStatus("edge", [condition("Accepted", "True", "Accepted")]),
          ],
        }),
      ],
      undefined,
      t
    );

    expect(data.columns.map((column) => column.label)).toEqual([
      "IP",
      "Gateways",
      "Routes",
      "Backends",
    ]);
    expect(data.spine).toBe(2);
    const [ips, gateways, routes, backends] = data.columns;
    expect(ips.nodes[0].label).toBe("203.0.113.9");
    expect(gateways.nodes[0].tone).toBe("ok");
    expect(routes.nodes[0].tone).toBe("ok");
    expect(routes.nodes[0].tag?.text).toBe("HTTPRoute");
    // Backing unread: the backend claims nothing rather than health.
    expect(backends.nodes[0].tone).toBe("mute");
    expect(data.edges).toHaveLength(3);
  });

  it("draws a named-but-absent gateway as the missing thing", () => {
    const data = gatewayTopology([], [route("promo")], undefined, t);
    const gateways = data.columns[0].nodes;
    expect(gateways).toHaveLength(1);
    expect(gateways[0].tone).toBe("err");
    expect(gateways[0].tag?.text).toBe("missing");
    // Not clickable: there is nothing to open.
    expect(gateways[0].object).toBeUndefined();
  });

  /**
   * The list above was read and the gateway was not in it — that is a fact.
   * An unread list is not: a namespace-scoped reader gets a 403 on the
   * cluster-wide list, and calling every parent "missing" turns a permission
   * into a cluster full of red.
   */
  it("does not call a gateway missing when the list was never read", () => {
    const data = gatewayTopology(undefined, [route("promo")], undefined, t);
    const gateways = data.columns[0].nodes;
    expect(gateways).toHaveLength(1);
    expect(gateways[0].tone).toBe("mute");
    expect(gateways[0].tag).toBeUndefined();
  });

  it("marks the refused attachment on the edge, in addition to the route", () => {
    const data = gatewayTopology(
      [gateway("edge")],
      [
        route("promo", {
          parents: [
            parentStatus("edge", [
              condition("Accepted", "False", "NoMatchingListenerHostname"),
            ]),
          ],
        }),
      ],
      undefined,
      t
    );
    expect(data.columns[data.spine!].nodes[0].tone).toBe("err");
    const attachment = data.edges.find((edge) => edge.from.startsWith("gw/"));
    expect(attachment?.tone).toBe("err");
  });

  it("gives a mesh parent no gateway node and no missing lie", () => {
    const data = gatewayTopology(
      [],
      [
        route("split", {
          parentRefs: [
            {
              group: "",
              kind: "Service",
              name: "split",
              namespace: null,
              sectionName: null,
              port: null,
            },
          ],
        }),
      ],
      undefined,
      t
    );
    expect(data.columns[0].nodes).toHaveLength(0);
    // The route and its backend still draw.
    expect(data.columns[1].nodes).toHaveLength(1);
    expect(data.columns[2].nodes).toHaveLength(1);
  });

  it("reads a backend through what its Service publishes", () => {
    const backing = {
      services: [
        {
          name: "promo",
          namespace: "gwtest",
          type: "ClusterIP",
          clusterIp: "10.0.0.1",
          externalIps: [],
          loadBalancerIps: [],
          ports: [],
          selector: { app: "promo" },
          sessionAffinity: "None",
          labels: {},
          annotations: {},
          createdAt: null,
        },
      ],
      published: [],
      backingKnown: true,
    };
    const data = gatewayTopology(
      [gateway("edge")],
      [route("promo")],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      backing as any,
      t
    );
    const backend = data.columns.at(-1)!.nodes[0];
    // A selector and nothing published: the Service's own stop, in its words.
    expect(backend.tone).toBe("err");
    // Not "no pod carries this": that reader holds the endpoints and no
    // pod list, and a Pending pod carries the selector while publishing
    // nothing.
    expect(backend.sub).toContain("Nothing is published");
  });

  it("funnels routes through per-gateway kind nodes once kinds differ", () => {
    const data = gatewayTopology(
      [gateway("edge", [condition("Programmed", "True", "Programmed")])],
      [
        route("web"),
        route("stream", {
          kind: "TCPRoute",
          hostnames: [],
          parents: [
            parentStatus("edge", [condition("Accepted", "False", "Refused")]),
          ],
        }),
      ],
      undefined,
      t
    );

    expect(data.columns.map((column) => column.label)).toEqual([
      "IP",
      "Gateways",
      "Kinds",
      "Routes",
      "Backends",
    ]);
    expect(data.spine).toBe(3);
    const kinds = data.columns[2].nodes;
    expect(kinds.map((node) => node.label).sort()).toEqual([
      "HTTPRoute",
      "TCPRoute",
    ]);
    expect(kinds[0].sub).toBe("1 route");
    // The broken lane carries its verdict on the gateway edge...
    const intoTcp = data.edges.find(
      (edge) => edge.to === "kind/gw/gwtest/edge/TCPRoute"
    );
    expect(intoTcp?.tone).toBe("err");
    // ...and the healthy lane does not.
    const intoHttp = data.edges.find(
      (edge) => edge.to === "kind/gw/gwtest/edge/HTTPRoute"
    );
    expect(intoHttp?.tone).toBe("mute");
    // No direct gateway→route edges remain.
    expect(
      data.edges.some(
        (edge) => edge.from.startsWith("gw/") && edge.to.startsWith("route/")
      )
    ).toBe(false);
  });

  it("keeps a single-kind map flat — no funnel of one", () => {
    const data = gatewayTopology(
      [gateway("edge")],
      [route("a"), route("b")],
      undefined,
      t
    );
    expect(data.columns.some((column) => column.label === "Kinds")).toBe(false);
  });

  it("resolves the workloads behind a backend, ReplicaSet hop included", () => {
    const backing = {
      services: [],
      published: [
        {
          service: { kind: "Service", name: "promo", namespace: "gwtest" },
          source: "EndpointSlice",
          slices: 1,
          ready: 1,
          draining: 0,
          notReady: 1,
          unrouted: 0,
          ports: [],
          endpoints: [
            {
              address: "10.1.0.5",
              target: {
                kind: "Pod",
                name: "promo-abc123-x1",
                namespace: "gwtest",
              },
              ready: true,
              serving: true,
              terminating: false,
              nodeName: null,
              zone: null,
              hintZones: [],
            },
            {
              address: "10.1.0.6",
              target: { kind: "Pod", name: "stray", namespace: "gwtest" },
              ready: false,
              serving: false,
              terminating: false,
              nodeName: null,
              zone: null,
              hintZones: [],
            },
          ],
          whole: true,
          unpublished: [],
        },
      ],
      backingKnown: true,
    };
    const pod = (name: string, owners: unknown[]) => ({
      name,
      namespace: "gwtest",
      uid: name,
      status: { phase: "Running", ready: true },
      nodeName: null,
      podIp: null,
      hostIp: null,
      containers: [],
      initContainers: [],
      labels: {},
      annotations: {},
      createdAt: null,
      restartCount: 0,
      lastRestartAt: null,
      cpuRequests: null,
      cpuLimits: null,
      memoryRequests: null,
      memoryLimits: null,
      ownerReferences: owners,
      volumes: [],
      serviceAccountName: null,
    });
    const data = gatewayTopology(
      [gateway("edge")],
      [route("promo")],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      backing as any,
      t,
      {
        pods: [
          pod("promo-abc123-x1", [
            {
              api_version: "apps/v1",
              kind: "ReplicaSet",
              name: "promo-abc123",
              uid: "rs",
              controller: true,
            },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ]) as any,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          pod("stray", []) as any,
        ],
        deployments: [{ name: "promo", namespace: "gwtest" }],
      }
    );

    const workloads = data.columns.at(-1)!;
    expect(workloads.label).toBe("Workloads");
    const labels = workloads.nodes.map((node) => node.label).sort();
    expect(labels).toEqual(["1 bare pod", "promo"]);
    const deployment = workloads.nodes.find((node) => node.label === "promo")!;
    expect(deployment.object?.kind).toBe("Deployment");
    expect(deployment.sub).toBe("1 of 1 ready");
    expect(deployment.tone).toBe("ok");
    const bare = workloads.nodes.find((node) => node.label === "1 bare pod")!;
    expect(bare.tone).toBe("err");
    expect(bare.object).toBeUndefined();
  });
});
