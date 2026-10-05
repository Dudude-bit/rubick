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
    listServiceBacking: () => Promise.resolve({ services: [], published: [] }),
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

  it("paints a Service that publishes nothing red", async () => {
    answer.connections = () => Promise.resolve(connections([EMPTY_SLICE]));
    await renderWithRouter(<>{statusOf("Service", SERVICE)}</>);
    expect(await screen.findByText("No endpoints")).toHaveClass(ROLE_TEXT.err);
  });

  /** A refused neighbourhood is "not checked", never "no endpoints". */
  it("says not checked when the neighbourhood was refused", async () => {
    answer.connections = () => Promise.reject(new Error("forbidden"));
    await renderWithRouter(<>{statusOf("Service", SERVICE)}</>);
    expect(await screen.findByText("forbidden")).toBeInTheDocument();
    expect(screen.getByText("not checked")).toHaveClass(ROLE_TEXT.neutral);
    expect(screen.queryByText("No endpoints")).toBeNull();
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
