import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type {
  IngressClassBinding,
  IngressInfo,
  ObjectRef,
  ResourceConnections,
} from "@/generated/types";

const getIngress =
  vi.fn<(name: string, namespace: string | null) => Promise<IngressInfo>>();
const resolveIngressClass =
  vi.fn<(className: string | null) => Promise<IngressClassBinding>>();

vi.mock("@/lib/commands", () => ({
  commands: {
    getIngress: (name: string, namespace: string | null) =>
      getIngress(name, namespace),
    resolveIngressClass: (className: string | null) =>
      resolveIngressClass(className),
    detectInClusterExtensions: () => Promise.resolve([]),
    getTlsCertificates: () => Promise.resolve([]),
    getCertificateIssuance: () => Promise.resolve(null),
  },
}));

const { useIngressRouting } = await import("./useIngressRouting");

function wrapper() {
  const client = new QueryClient({
    // The hook decides what is worth asking twice; the delay is the only part
    // of that a test has any business shortening.
    defaultOptions: { queries: { retry: false, retryDelay: 0 } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

const ingress: ObjectRef = {
  kind: "Ingress",
  name: "shop",
  namespace: "storefront",
  existence: "present",
  facts: null,
};

const service: ObjectRef = {
  kind: "Service",
  name: "shop",
  namespace: "storefront",
  existence: "present",
  facts: null,
};

const conns: ResourceConnections = {
  subject: service,
  edges: [
    {
      from: ingress,
      to: service,
      relation: {
        verb: "routes",
        host: "shop.example.com",
        path: "/",
        pathType: "Prefix",
        port: "80",
        tls: false,
      },
    },
  ],
  stops: [],
  published: [],
  notLookedAt: [],
};

const info = (className: string | null): IngressInfo => ({
  name: "shop",
  namespace: "storefront",
  className,
  rules: [],
  loadBalancerIps: [],
  tlsHosts: [],
  tlsConfigs: [],
  hasCatchAllTls: false,
  labels: {},
  annotations: {},
  createdAt: null,
});

describe("useIngressRouting", () => {
  beforeEach(() => {
    getIngress.mockReset();
    resolveIngressClass.mockReset();
  });

  /**
   * Would break if a pending `getIngress` read went back to standing in for
   * a genuinely classless Ingress: `resolve_ingress_class(null)` reads every
   * IngressClass in the cluster to answer the default controller's identity,
   * and firing it before this Ingress's own class is known would draw a
   * default-controller answer nobody asked for.
   */
  it("asks nothing about a class while the Ingress read is still pending", async () => {
    let resolveGetIngress: (value: IngressInfo) => void = () => {};
    getIngress.mockReturnValue(
      new Promise((resolve) => {
        resolveGetIngress = resolve;
      })
    );
    resolveIngressClass.mockResolvedValue({
      requested: null,
      resolved: "nginx",
      controller: "k8s.io/ingress-nginx",
      viaDefault: true,
      available: [],
    });

    renderHook(() => useIngressRouting(conns), { wrapper: wrapper() });

    await waitFor(() => expect(getIngress).toHaveBeenCalled());
    expect(resolveIngressClass).not.toHaveBeenCalled();

    resolveGetIngress(info(null));
    await waitFor(() => expect(resolveIngressClass).toHaveBeenCalledWith(null));
  });

  /**
   * The other half: once the Ingress genuinely names no class, that is a
   * real, meaningful answer — not the same as "not read yet" — and the
   * binding the cluster gives back for it must reach the routing map rather
   * than being collapsed to `null`.
   */
  it("attaches the real binding once a genuinely classless Ingress resolves", async () => {
    getIngress.mockResolvedValue(info(null));
    resolveIngressClass.mockResolvedValue({
      requested: null,
      resolved: "nginx",
      controller: "k8s.io/ingress-nginx",
      viaDefault: true,
      available: [],
    });

    const { result } = renderHook(() => useIngressRouting(conns), {
      wrapper: wrapper(),
    });

    await waitFor(() => {
      const routed = result.current.routing.get("Ingress/storefront/shop");
      expect(routed?.binding?.viaDefault).toBe(true);
      expect(routed?.binding?.controller).toBe("k8s.io/ingress-nginx");
    });
  });

  /**
   * Would break if a refused read went back to looking like a pending one:
   * both leave the Ingress out of `routing`, the chain draws the same missing
   * address, missing certificate and missing controller for either, and for
   * the refusal that is permanent — so the failure has to come out somewhere
   * a surface can say it, verbatim and without this app's framing on it.
   */
  it("names a read that failed instead of leaving it as a gap", async () => {
    getIngress.mockRejectedValue(
      new Error(
        `Tauri command 'getIngress' failed: ingresses.networking.k8s.io "shop" is forbidden`
      )
    );

    const { result } = renderHook(() => useIngressRouting(conns), {
      wrapper: wrapper(),
    });

    await waitFor(() => expect(result.current.unread).toHaveLength(1));
    expect(result.current.unread[0].ingress.name).toBe("shop");
    expect(result.current.unread[0].what).toBe("ingress");
    expect(result.current.unread[0].reason).toBe(
      `ingresses.networking.k8s.io "shop" is forbidden`
    );

    // Nothing may stand in for what was not read: an entry here with no
    // addresses would say the controller has published none.
    expect(result.current.routing.has("Ingress/storefront/shop")).toBe(false);
    // A refusal is an answer, so it is never asked twice.
    expect(getIngress).toHaveBeenCalledTimes(1);
    expect(resolveIngressClass).not.toHaveBeenCalled();
  });

  /**
   * The other half of the same rule. Would break if a dropped connection
   * stopped being retried: one blip would leave a workload page silent about
   * its own URL and certificate until somebody navigated away and back.
   */
  it("asks again after a failure that is not an answer", async () => {
    getIngress.mockRejectedValue(new Error("Connection error: reset by peer"));

    const { result } = renderHook(() => useIngressRouting(conns), {
      wrapper: wrapper(),
    });

    await waitFor(() => expect(getIngress).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.unread).toHaveLength(1));
  });
});
