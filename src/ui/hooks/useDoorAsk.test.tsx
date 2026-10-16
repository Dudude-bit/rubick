import { describe, expect, it, vi } from "vite-plus/test";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";

const answer = vi.hoisted(() => ({
  classes: null as Error | null,
  asked: [] as Array<string[] | null>,
  gatewayApi: false,
}));

vi.mock("@/integrations", () => ({
  ROUTING_STALE: 60_000,
  useCapabilities: () => [
    (controller: string) =>
      controller === "traefik.io/ingress-controller" ||
      controller === "traefik.io/gateway-controller"
        ? {
            name: "Traefik",
            read: async () => [
              {
                name: "traefik-7d9",
                namespace: "traefik",
                labels: {},
                ip: "10.42.1.7",
                hostNetwork: false,
              },
            ],
          }
        : null,
  ],
}));

vi.mock("@/hooks/useGatewayApi", () => ({
  useGatewayApi: () => ({
    data: answer.gatewayApi
      ? { installed: true, kinds: [{ kind: "GatewayClass" }] }
      : undefined,
  }),
}));

vi.mock("@/lib/commands", () => ({
  commands: {
    listGatewayClasses: () =>
      Promise.resolve([
        { name: "traefik", controllerName: "traefik.io/gateway-controller" },
      ]),
    resolveIngressClass: () =>
      answer.classes
        ? Promise.reject(answer.classes)
        : Promise.resolve({
            requested: null,
            resolved: "traefik",
            controller: "traefik.io/ingress-controller",
            viaDefault: true,
            available: [
              {
                name: "traefik",
                controller: "traefik.io/ingress-controller",
                isDefault: true,
                parameters: null,
              },
              {
                name: "nginx",
                controller: "k8s.io/ingress-nginx",
                isDefault: false,
                parameters: null,
              },
            ],
          }),
    listNamespaces: () => Promise.resolve([{ name: "traefik", labels: {} }]),
    listNetworkPoliciesIn: (scope: string[] | null) => {
      answer.asked.push(scope);
      return Promise.resolve({
        rows: [],
        unread: [{ namespace: "traefik", code: "FORBIDDEN", message: "no" }],
      });
    },
  },
}));

import { testQueryClient } from "@/test/render";
import { useDoorAsk } from "./useDoorAsk";

const render = () => {
  const client = testQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(() => useDoorAsk(), { wrapper });
};

describe("who each IngressClass and GatewayClass controller connects from", () => {
  /**
   * A controller no integration claims is not one whose pods are still
   * being read. Fails if it reads as pending for good, or if a claimed one
   * never gets its pods and its namespaces.
   */
  it("reads a claimed controller's pods and says no integration speaks for another", async () => {
    answer.classes = null;
    const { result } = render();
    expect(result.current("traefik.io/ingress-controller")).toBeUndefined();
    expect(result.current("k8s.io/ingress-nginx")).toBeNull();
    await waitFor(() =>
      expect(result.current("traefik.io/ingress-controller")).toMatchObject({
        name: "Traefik",
        clients: { known: true, value: [{ name: "traefik-7d9" }] },
        namespaces: { known: true },
      })
    );
  });

  /**
   * A controller's own egress policies decide whether it reaches a backend
   * at all. Fails if they are not read, are read across the whole cluster
   * rather than where its pods run, or lose a namespace's refusal.
   */
  it("reads the NetworkPolicies in the namespaces a claimed controller's pods run in", async () => {
    answer.classes = null;
    answer.asked = [];
    const { result } = render();
    await waitFor(() =>
      expect(result.current("traefik.io/ingress-controller")).toMatchObject({
        egress: {
          known: true,
          value: { unread: [{ namespace: "traefik", message: "no" }] },
        },
      })
    );
    expect(answer.asked).toEqual([["traefik"]]);
  });

  /**
   * Traefik's Gateway provider runs in the same pods under a controllerName
   * of its own. Fails if a GatewayClass's controller is never asked about,
   * or a Gateway's class does not lead to the controller to ask.
   */
  it("reads the controller a GatewayClass names and says which one a class names", async () => {
    answer.classes = null;
    answer.gatewayApi = false;
    expect(render().result.current.classController).toBeUndefined();

    answer.gatewayApi = true;
    const { result } = render();
    await waitFor(() =>
      expect(result.current("traefik.io/gateway-controller")).toMatchObject({
        name: "Traefik",
        clients: { known: true, value: [{ name: "traefik-7d9" }] },
      })
    );
    expect(result.current.classController?.("traefik")).toBe(
      "traefik.io/gateway-controller"
    );
    expect(result.current.classController?.("envoy")).toBeUndefined();
    answer.gatewayApi = false;
  });

  /** Classes nobody may list leave the claimed controller unread, said why, never pending. */
  it("says why a claimed controller's pods are unknown where its class could not be read", async () => {
    answer.classes = new Error("ingressclasses is forbidden (code: 403)");
    const { result } = render();
    await waitFor(() =>
      expect(result.current("traefik.io/ingress-controller")).toMatchObject({
        name: "Traefik",
        clients: { known: false, why: expect.stringContaining("forbidden") },
        egress: { known: false, why: expect.stringContaining("forbidden") },
      })
    );
  });
});
