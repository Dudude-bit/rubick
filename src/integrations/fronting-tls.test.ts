// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

import type { ServiceInfo } from "@/generated/types";

const answers = vi.hoisted(() => ({
  routes: {
    routes: [] as Array<{ host: string; tls: boolean | null }>,
    isPending: false,
    error: null as Error | null,
  },
  /** What a cloud controller says about a host it was asked about. */
  front: new Map<string, boolean | null>(),
}));

vi.mock("@/hooks/useServiceRoutes", () => ({
  useServiceRoutes: (service: unknown) =>
    service ? answers.routes : { routes: [], isPending: false, error: null },
}));
vi.mock("@/hooks/useIngressTls", () => ({
  // Answers only for the hosts it was asked about, as a supplier does.
  useIngressTls: (
    asked: Array<{ namespace: string; name: string; hosts: string[] }>
  ) => ({
    available: true,
    of: (ingress: { namespace: string; name: string }, host: string) => {
      const was = asked.find(
        (entry) =>
          entry.namespace === ingress.namespace &&
          entry.name === ingress.name &&
          entry.hosts.includes(host)
      );
      const said = answers.front.get(`${ingress.name}/${host}`);
      return was && said !== undefined
        ? { host, terminated: said, by: { key: "verbatimLine" } }
        : null;
    },
    isPending: false,
    error: null,
  }),
}));

import type { IngressInfo } from "@/generated/types";
import { useFrontingTls } from "./fronting-tls";

const LABEL = ["app.kubernetes.io/name", "traefik"] as const;

const proxy = {
  name: "traefik",
  namespace: "kube-system",
  selector: { "app.kubernetes.io/name": "traefik" },
} as unknown as ServiceInfo;

/** An Ingress sending everything to the proxy, naming no host of its own. */
const edge = {
  name: "edge",
  namespace: "kube-system",
  rules: [],
  defaultBackend: {
    backendService: "traefik",
    backendPort: "80",
    resourceBackend: null,
  },
} as unknown as IngressInfo;

/** An Ingress routing the host itself to the proxy. */
const shop = {
  name: "shop",
  namespace: "kube-system",
  rules: [
    {
      host: "shop.example.com",
      paths: [{ path: "/", backendService: "traefik", backendPort: "80" }],
    },
  ],
  defaultBackend: null,
} as unknown as IngressInfo;

const SERVED = ["shop.example.com"];

const ask = (
  services: ServiceInfo[] | undefined,
  ingresses: IngressInfo[] = []
) =>
  renderHook(() =>
    useFrontingTls(ingresses, services, LABEL, SERVED)
  ).result.current("shop.example.com");

beforeEach(() => {
  answers.routes = { routes: [], isPending: false, error: null };
  answers.front = new Map();
});

describe("whether something in front terminates TLS", () => {
  /**
   * With the Services unread there is no proxy to ask about, and the hook
   * answered a plain `false` — which the page read as "nothing in front".
   */
  it("could not say while the Services are unread", () => {
    expect(ask(undefined)).toBe("unknown");
  });

  /** A capability still being asked has not said no. */
  it("could not say while the proxy's routes are still being read", () => {
    answers.routes = { routes: [], isPending: true, error: null };
    expect(ask([proxy])).toBe("unknown");
  });

  /** Nor has one that failed. */
  it("could not say when the proxy's routes could not be read", () => {
    answers.routes = { routes: [], isPending: false, error: new Error("x") };
    expect(ask([proxy])).toBe("unknown");
  });

  /** Everything read and nothing in front is the one real "no". */
  it("says no once everything answered and nothing terminates it", () => {
    expect(ask([proxy])).toBe(false);
    expect(ask([])).toBe(false);
  });

  /** GKE answers `tls: null` for a route whose ManagedCertificate it could not list; read as "no", every host behind it was called served in the clear. Fails if the null is dropped. */
  it("could not say when the route in front could not tell whether it terminates", () => {
    answers.routes = {
      routes: [{ host: "shop.example.com", tls: null }],
      isPending: false,
      error: null,
    };
    expect(ask([proxy])).toBe("unknown");
  });

  /**
   * GKE answers `null` for a host whose ManagedCertificate it could not
   * list; read as silence, the proxy's hosts were called served in the
   * clear. Fails if the null is dropped.
   */
  it("could not say when the controller in front could not read its certificate", () => {
    answers.front.set("shop/shop.example.com", null);
    expect(ask([proxy], [shop])).toBe("unknown");
  });

  /**
   * A load balancer sending everything to the proxy through
   * `spec.defaultBackend` names no host, and was asked about none — so its
   * certificate, read or not, never reached a single host behind it.
   */
  it("asks a hostless Ingress in front about the hosts the proxy serves", () => {
    answers.front.set("edge/shop.example.com", true);
    expect(ask([proxy], [edge])).toBe(true);
  });

  it("says yes for a host a route in front serves over TLS", () => {
    answers.routes = {
      routes: [{ host: "shop.example.com", tls: true }],
      isPending: false,
      error: null,
    };
    expect(ask([proxy])).toBe(true);
  });
});
