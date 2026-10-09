import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { screen } from "@testing-library/react";

import type {
  EndpointsInfo,
  IngressInfo,
  ResourceConnections,
  ServiceInfo,
  ServicePublished,
} from "@/generated/types";
import type { KeyValue } from "@/components/object/key-values";

// A plain function, not a `vi.fn`: a spy's rejected promise is reported as
// the test's own failure even after the query has handled it.
const answer = vi.hoisted(() => ({
  connections: (): Promise<ResourceConnections> =>
    Promise.reject(new Error("not set")),
}));

vi.mock("@/lib/commands", () => ({
  commands: {
    getResourceConnections: () => answer.connections(),
    detectGatewayApi: () => Promise.resolve(null),
    listServicesIn: () => Promise.resolve({ rows: [], unread: [] }),
    resolveIngressClass: () =>
      Promise.resolve({
        requested: "nginx",
        resolved: null,
        controller: null,
        viaDefault: false,
        available: [],
      }),
    listServiceHealthInputs: () => Promise.resolve({ rows: [], unread: [] }),
    getTlsCertificates: () => Promise.resolve([]),
  },
}));

const { resolveSource } = await import("./peek-sources");
const { ServiceHealthView, IngressHealthView } =
  await import("../-object/health-views");
const { renderWithRouter } = await import("@/test/render");
const { translate } = await import("@/i18n");
const { ROLE_TEXT } = await import("@/lib/status-role");

const t = ((section: never, key: never, values: never) =>
  translate("en", section, key, values)) as never;

const target = (kind: string) => ({ kind, name: "web", namespace: "net" });

function statusOf(kind: string, data: unknown): ReactNode {
  const groups = resolveSource(target(kind)).summarise(
    data,
    target(kind),
    t
  ).groups;
  const items: KeyValue[] = groups.flatMap((group) => group.items);
  return items.find((item) => item.label === "Status")?.value;
}

const SERVICE = {
  name: "web",
  namespace: "net",
  type: "ClusterIP",
  externalIps: [],
  loadBalancerIps: [],
  ports: [],
  selector: { app: "web" },
  clusterIp: "10.0.0.1",
  createdAt: null,
} as unknown as ServiceInfo;

const EMPTY_SLICE: ServicePublished = {
  service: {
    kind: "Service",
    name: "web",
    namespace: "net",
    existence: "present",
    facts: null,
  },
  source: "slices",
  slices: 1,
  ready: 0,
  draining: 0,
  notReady: 0,
  unrouted: 2,
  unroutedReady: 2,
  ports: [],
  endpoints: [],
  whole: true,
  unpublished: [],
  stop: null,
};

const connections = (published: ServicePublished[]): ResourceConnections => ({
  subject: {
    kind: "Service",
    name: "web",
    namespace: "net",
    existence: "present",
    facts: {
      kind: "service",
      type: "ClusterIP",
      clusterIp: "10.0.0.1",
      externalName: null,
      selector: "app=web",
      ports: [],
    },
  },
  edges: [],
  stops: [],
  published,
  notLookedAt: [],
});

describe("the peek draws a network object's verdict as its page does", () => {
  /**
   * The peek of `web` was a neutral path with no red, while its page said
   * it publishes no endpoint. The Service, its Endpoints and the page share
   * one component; fails if a peek stops carrying it.
   */
  it("puts the page's own verdict on the Service and Endpoints peeks", () => {
    const service = statusOf("Service", SERVICE);
    const endpoints = statusOf("Endpoints", {
      name: "web",
      namespace: "net",
      subsets: [],
      createdAt: null,
    } as unknown as EndpointsInfo);
    for (const value of [service, endpoints]) {
      expect(isValidElement(value)).toBe(true);
      expect((value as ReactElement).type).toBe(ServiceHealthView);
    }
    const ingress = statusOf("Ingress", {
      name: "web",
      namespace: "net",
      className: "nginx",
      rules: [],
      defaultBackend: null,
      loadBalancerIps: [],
      tlsHosts: [],
      tlsConfigs: [],
      createdAt: null,
    } as unknown as IngressInfo);
    expect((ingress as ReactElement).type).toBe(IngressHealthView);
  });

  /** An ExternalName has no endpoints by hand: it has none at all. */
  it("draws no selector row for an ExternalName", () => {
    const groups = resolveSource(target("Service")).summarise(
      { ...SERVICE, type: "ExternalName", selector: {} },
      target("Service"),
      t
    ).groups;
    const labels = groups.flatMap((group) =>
      group.items.map((item) => item.label)
    );
    expect(labels).not.toContain("Selector");
    expect(labels).toContain("Status");
  });

  /**
   * The Service peek said "Внешний: нет" where its page says "Внешние IP",
   * and folded the balancer into that row. Fails if the peek's rows stop
   * being the page's.
   */
  it("labels external IPs and the balancer as the Service page does", () => {
    const labels = (service: ServiceInfo) =>
      resolveSource(target("Service"))
        .summarise(service, target("Service"), t)
        .groups.flatMap((group) => group.items.map((item) => item.label));
    expect(labels(SERVICE)).toContain("External IPs");
    expect(labels(SERVICE)).not.toContain("Load balancer");
    expect(labels({ ...SERVICE, type: "LoadBalancer" })).toEqual(
      expect.arrayContaining(["External IPs", "Load balancer"])
    );
  });

  /**
   * The Endpoints peek said "готово 1", then "Готовность 1", then "Не готовы
   * 0". Fails if the ready count comes back as a row of its own beside the
   * verdict that already carries it.
   */
  it("gives the Endpoints peek no ready row beside its verdict", () => {
    const labels = resolveSource(target("Endpoints"))
      .summarise(
        {
          name: "web",
          namespace: "net",
          subsets: [],
          createdAt: null,
        } as unknown as EndpointsInfo,
        target("Endpoints"),
        t
      )
      .groups.flatMap((group) => group.items.map((item) => item.label));
    expect(labels).toEqual(expect.arrayContaining(["Status", "Not ready"]));
    expect(labels).not.toContain("Ready");
  });

  it("paints a Service that publishes nothing red", async () => {
    answer.connections = () => Promise.resolve(connections([EMPTY_SLICE]));
    await renderWithRouter(<>{statusOf("Service", SERVICE)}</>);
    expect(await screen.findByText("no endpoints")).toHaveClass(ROLE_TEXT.err);
  });

  /** A refused neighbourhood is "not checked", never "no endpoints". */
  it("says not checked when the neighbourhood was refused", async () => {
    answer.connections = () => Promise.reject(new Error("forbidden"));
    await renderWithRouter(<>{statusOf("Service", SERVICE)}</>);
    expect(await screen.findByText("forbidden")).toBeInTheDocument();
    expect(screen.getByText("not checked")).toHaveClass(ROLE_TEXT.neutral);
    expect(screen.queryByText("no endpoints")).toBeNull();
  });

  describe("an Endpoints peek's addresses not ready", () => {
    const unready = {
      name: "web",
      namespace: "net",
      createdAt: null,
      subsets: [
        {
          addresses: [],
          notReadyAddresses: [
            {
              ip: "10.42.1.182",
              hostname: null,
              nodeName: "agent-0",
              targetRef: { kind: "Pod", name: "web-499fh", namespace: "net" },
            },
          ],
          ports: [],
        },
      ],
    } as unknown as EndpointsInfo;
    const answered = (why: "podsUnread" | "failingReadiness") => {
      answer.connections = () =>
        Promise.resolve(
          connections([
            {
              ...EMPTY_SLICE,
              unrouted: 0,
              unroutedReady: 0,
              notReady: 1,
              stop: {
                reason: "noneReady",
                service: EMPTY_SLICE.service,
                selector: "app=web",
                pods: 1,
                why,
              },
            },
          ])
        );
      const items = resolveSource(target("Endpoints"))
        .summarise(unready, target("Endpoints"), t)
        .groups.flatMap((group) => group.items);
      return renderWithRouter(
        <>
          {items.find((item) => item.label === "Not ready")?.value}
          {
            items.find(
              (item) =>
                item.label !== "Not ready" &&
                item.label !== "Status" &&
                item.label !== "Ports"
            )?.value
          }
        </>
      );
    };

    /**
     * Marco's ledger, pods unread: the peek's header said grey "none ready"
     * while its Not ready count and its pod row were amber. Fails if either
     * draws a fault's colour, or loses the not-read mark, while the pods
     * were not read.
     */
    it("draws them without amber, with the not-read mark, while the pods are unread", async () => {
      await answered("podsUnread");
      expect(
        await screen.findAllByRole("img", { name: "pods not read" })
      ).toHaveLength(2);
      expect(screen.getByText("not ready")).not.toHaveClass("text-warn");
      expect(screen.getByText("1")).not.toHaveClass("text-warn");
    });

    /** Fails if addresses its pods do explain lose their amber. */
    it("draws them amber once the pods were read", async () => {
      await answered("failingReadiness");
      expect(await screen.findByText("not ready")).toHaveClass("text-warn");
      expect(screen.queryByRole("img", { name: "pods not read" })).toBeNull();
    });
  });

  /** An Ingress whose class nothing serves says so in its peek. */
  it("names the missing controller on the Ingress peek", async () => {
    await renderWithRouter(
      <>
        {statusOf("Ingress", {
          name: "storefront",
          namespace: "net",
          className: "nginx",
          rules: [],
          defaultBackend: null,
          loadBalancerIps: [],
          tlsHosts: [],
          tlsConfigs: [],
          createdAt: null,
        } as unknown as IngressInfo)}
      </>
    );
    expect(await screen.findByText("no controller")).toHaveClass(ROLE_TEXT.err);
  });
});
