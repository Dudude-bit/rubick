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
}));

vi.mock("@/hooks/useServiceRoutes", () => ({
  useServiceRoutes: (service: unknown) =>
    service ? answers.routes : { routes: [], isPending: false, error: null },
}));
vi.mock("@/hooks/useIngressTls", () => ({
  useIngressTls: () => ({
    available: false,
    of: () => null,
    isPending: false,
    error: null,
  }),
}));

import { useFrontingTls } from "./fronting-tls";

const LABEL = ["app.kubernetes.io/name", "traefik"] as const;

const proxy = {
  name: "traefik",
  namespace: "kube-system",
  selector: { "app.kubernetes.io/name": "traefik" },
} as unknown as ServiceInfo;

const ask = (services: ServiceInfo[] | undefined) =>
  renderHook(() => useFrontingTls([], services, LABEL)).result.current(
    "shop.example.com"
  );

beforeEach(() => {
  answers.routes = { routes: [], isPending: false, error: null };
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

  it("says yes for a host a route in front serves over TLS", () => {
    answers.routes = {
      routes: [{ host: "shop.example.com", tls: true }],
      isPending: false,
      error: null,
    };
    expect(ask([proxy])).toBe(true);
  });
});
