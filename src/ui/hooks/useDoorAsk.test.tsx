import { describe, expect, it, vi } from "vite-plus/test";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";

const answer = vi.hoisted(() => ({ classes: null as Error | null }));

vi.mock("@/integrations", () => ({
  useCapabilities: () => [
    (controller: string) =>
      controller === "traefik.io/ingress-controller"
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

vi.mock("@/lib/commands", () => ({
  commands: {
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

describe("who each IngressClass controller connects from", () => {
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

  /** Classes nobody may list leave the claimed controller unread, said why, never pending. */
  it("says why a claimed controller's pods are unknown where its class could not be read", async () => {
    answer.classes = new Error("ingressclasses is forbidden (code: 403)");
    const { result } = render();
    await waitFor(() =>
      expect(result.current("traefik.io/ingress-controller")).toMatchObject({
        name: "Traefik",
        clients: { known: false, why: expect.stringContaining("forbidden") },
      })
    );
  });
});
