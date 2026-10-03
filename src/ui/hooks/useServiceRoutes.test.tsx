import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";

const capabilities = vi.hoisted(() => ({
  "service.routes": [] as unknown[],
  "ingress.tls": [] as unknown[],
}));

vi.mock("@/integrations", () => ({
  useCapabilities: (key: keyof typeof capabilities) => capabilities[key],
}));

import { testQueryClient } from "@/test/render";
import { useServiceRoutes, useServicesRoutes } from "./useServiceRoutes";

/** A fresh cache each, so neither hook reads the other's answer. */
const freshCache = () => {
  const client = testQueryClient();
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
};

beforeEach(() => {
  capabilities["service.routes"] = [
    () => Promise.reject(new Error("ingressroutes.traefik.io is forbidden")),
  ];
  capabilities["ingress.tls"] = [];
});

describe("the routes vendors state for several Services", () => {
  /**
   * The one-Service hook carried a supplier's failure; the several-Service
   * one dropped it, so a refused vendor read looked exactly like "no vendor
   * routes this" in the traffic chain and the peek.
   */
  it("carries a supplier that did not answer", async () => {
    const client = testQueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(
      () => useServicesRoutes([{ namespace: "shop", name: "web" }]),
      { wrapper }
    );
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.error?.message).toContain("forbidden");
    expect(result.current.routes.size).toBe(0);
  });
});

describe("the scheme of a route with a load balancer in front", () => {
  /**
   * The route's own vendor reads only `spec.tls`; the certificate in front is
   * an ACM ARN another vendor reads. The proxy's page asked that vendor and
   * the Service page, the peek and the Argo CD page did not, so they printed
   * `http://` beside a page saying TLS ends at the edge. Fails if either hook
   * hands out a route without asking what is in front of it.
   */
  it("is what the controller in front says, for one Service or several", async () => {
    capabilities["service.routes"] = [
      async (service: { name: string }) =>
        service.name === "argocd-server"
          ? [
              {
                host: "argocd.example.com",
                path: "/",
                tls: false,
                source: {
                  kind: "IngressRoute",
                  name: "argocd",
                  namespace: "argocd",
                },
                front: {
                  ingresses: [{ namespace: "edge", name: "edge" }],
                  proxy: { namespace: "edge", name: "traefik" },
                },
              },
            ]
          : [],
    ];
    capabilities["ingress.tls"] = [
      async (wanted: Array<{ hosts: string[] }>) =>
        wanted.map((entry) =>
          entry.hosts.map((host) => ({
            host,
            terminated: true,
            by: { key: "awsAcmCertificate" },
          }))
        ),
    ];
    const service = { namespace: "argocd", name: "argocd-server" };

    const one = renderHook(() => useServiceRoutes(service), {
      wrapper: freshCache(),
    });
    await waitFor(() => expect(one.result.current.isPending).toBe(false));
    expect(one.result.current.routes[0]?.tls).toBe(true);

    const several = renderHook(() => useServicesRoutes([service]), {
      wrapper: freshCache(),
    });
    await waitFor(() => expect(several.result.current.isPending).toBe(false));
    expect(
      several.result.current.routes.get("argocd/argocd-server")?.[0]?.tls
    ).toBe(true);
  });
});
