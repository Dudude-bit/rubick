import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { screen, within } from "@testing-library/react";

import { renderWithRouter } from "@/test/render";

vi.mock("@/lib/commands", () => ({
  commands: {
    detectInClusterExtensions: vi.fn(async () => []),
    listIngresses: vi.fn(async () => []),
    listCustomResources: vi.fn(async () => []),
    resolveIngressClass: vi.fn(async () => null),
    getClusterOverview: vi.fn(async () => null),
    checkListAccess: vi.fn(async () => []),
    checkCrdReadAccess: vi.fn(async () => false),
    detectGatewayApi: vi.fn(async () => ({ installed: false, kinds: [] })),
    listGatewayRoutesIn: vi.fn(async () => ({ rows: [], unread: [] })),
    listGateways: vi.fn(async () => []),
    listGatewaysIn: vi.fn(async () => ({ rows: [], unread: [] })),
    listGatewayClasses: vi.fn(async () => []),
    listServices: vi.fn(async () => []),
    listServiceEndpoints: vi.fn(async () => []),
  },
}));

const read = vi.hoisted(() => {
  const overview = {
    counts: { pods: 0, events: 0, nodes: 2 },
    problems: [],
    problemsTruncated: 0,
  };
  return {
    overview,
    whole: { data: overview },
    scoped: {
      data: overview,
      dataUpdatedAt: 1,
      freshness: { everyMs: 10_000, slowRead: false },
    },
    attention: { total: 0, worst: null, complete: true },
  };
});
vi.mock("@/hooks/useClusterOverview", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useClusterOverview")>()),
  useClusterOverview: () => read.whole,
  useScopedOverview: () => read.scoped,
}));
vi.mock("@/hooks/useAttention", () => ({
  useAttention: () => read.attention,
}));

const { Sidebar } = await import("./Sidebar");
const { useClusterStore } = await import("@/stores/clusterStore");
const { useLocaleStore } = await import("@/stores/localeStore");

const row = (name: string) =>
  screen.findByRole("link", { name: new RegExp(`^${name}`) });

beforeEach(() => {
  useClusterStore.setState({
    isConnected: true,
    currentContext: "acme-staging",
    pendingContext: null,
    live: [],
    namespaceScope: ["lena"],
  });
  useLocaleStore.setState({ choice: "en" });
});

describe("the rail's counts over a namespace the cluster does not have", () => {
  /**
   * Lena's rail read Pods 0 and Events 0 for "lena", a namespace that is
   * not there: a count of nothing reads as a quiet namespace. Fails if a
   * row counting what the scope holds prints a number for a missing one,
   * or if a count of the whole cluster is taken away with it.
   */
  it("marks the scoped counts missing and keeps the cluster's own", async () => {
    await renderWithRouter(
      <Sidebar missing={{ missing: ["lena"], whole: true, checking: false }} />,
      { at: "/c/acme-staging", route: "/c/$cluster/$" }
    );

    const pods = await row("Pods");
    expect(within(pods).queryByText("0")).toBeNull();
    expect(
      within(pods).getByRole("img", {
        name: "There is no namespace named lena in this cluster, so there is nothing to count.",
      })
    ).toBeInTheDocument();
    expect(within(await row("Events")).queryByText("0")).toBeNull();
    expect(within(await row("Nodes")).getByText("2")).toBeInTheDocument();
  });

  /** The other side: with every namespace there, the rail counts as it always has. */
  it("counts as before when nothing in the scope is missing", async () => {
    await renderWithRouter(<Sidebar />, {
      at: "/c/acme-staging",
      route: "/c/$cluster/$",
    });

    expect(within(await row("Pods")).getByText("0")).toBeInTheDocument();
    expect(screen.queryByTestId("scope-missing-count")).toBeNull();
  });
});

describe("the Routes row of a reader bound to their namespace", () => {
  /**
   * marco may list HTTPRoutes in his namespace and neither GRPCRoutes nor
   * Gateways. The routes page put his refused route under "Not serving",
   * and the rail beside it stayed blank: a count nobody could finish took
   * the break's dot down with it. Fails if an unknown count hides a read break.
   */
  it("wears the broken dot beside a count it could not finish", async () => {
    const { commands } = await import("@/lib/commands");
    const edge = {
      group: "gateway.networking.k8s.io",
      kind: "Gateway",
      name: "edge",
      namespace: "infra",
      sectionName: null,
      port: null,
    };
    const kind = (name: string, plural: string) => ({
      kind: name,
      plural,
      versions: ["v1"],
      readVersion: "v1",
    });
    vi.mocked(commands.detectGatewayApi).mockResolvedValue({
      installed: true,
      bundleVersion: null,
      channel: null,
      mixedBundle: null,
      kinds: [
        kind("Gateway", "gateways"),
        kind("HTTPRoute", "httproutes"),
        kind("GRPCRoute", "grpcroutes"),
      ],
    } as never);
    vi.mocked(commands.listGateways).mockRejectedValue({
      code: "PERMISSION_DENIED",
      message: "gateways is forbidden",
    });
    vi.mocked(commands.listGatewayRoutesIn).mockImplementation((async (
      routeKind: string
    ) => {
      if (routeKind === "GRPCRoute") {
        throw { code: "PERMISSION_DENIED", message: "grpcroutes is forbidden" };
      }
      return {
        rows: [
          {
            uid: "",
            kind: "HTTPRoute",
            apiVersion: "gateway.networking.k8s.io/v1",
            name: "checkout",
            namespace: "lena",
            hostnames: ["checkout.example.com"],
            parentRefs: [edge],
            rules: [],
            parents: [
              {
                parent: edge,
                controllerName: "example.net/gateway",
                conditions: [
                  {
                    type: "Accepted",
                    status: "False",
                    reason: "NoMatchingListenerHostname",
                    message: null,
                    lastTransitionTime: null,
                    observedGeneration: 1,
                  },
                ],
              },
            ],
            generation: 1,
            labels: {},
            annotations: {},
            createdAt: null,
          },
        ],
        unread: [],
      };
    }) as never);

    await renderWithRouter(<Sidebar />, {
      at: "/c/acme-staging",
      route: "/c/$cluster/$",
    });

    expect(
      await within(await row("Routes")).findByRole("img", { name: "broken" })
    ).toBeInTheDocument();
  });
});
