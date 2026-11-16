// @vitest-environment jsdom
import { describe, expect, it, vi } from "vite-plus/test";
import { renderHook } from "@testing-library/react";

import type { TopologyNode } from "@/generated/types";
import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import type { Delivery, DeliveryQuery, ServiceRoute } from "@/integrations";
import { layersOf, useVendorLayers } from "./vendor-layers";

const asked = vi.hoisted(() => ({
  deliveries: [] as unknown[][],
  routes: [] as unknown[][],
}));
vi.mock("../-delivery/useDelivery", () => ({
  useDeliveries: (objects: unknown[]) => {
    asked.deliveries.push(objects);
    return { available: true, of: () => [], isPending: false, error: null };
  },
}));
vi.mock("@/hooks/useServiceRoutes", () => ({
  useServicesRoutes: (services: unknown[]) => {
    asked.routes.push(services);
    return {
      available: true,
      routes: new Map(),
      isPending: false,
      error: null,
    };
  },
}));

const t: T = (section, key, values) => translate("en", section, key, values);

const cart: DeliveryQuery = {
  group: "apps",
  kind: "Deployment",
  name: "cart",
  namespace: "shop",
  labels: {},
  annotations: {
    "argocd.argoproj.io/tracking-id": "shop:apps/Deployment:shop/cart",
  },
};

const delivered = (warning: boolean): Delivery =>
  ({
    state: "delivered",
    source: {
      vendor: "Argo CD",
      vendorId: "argocd",
      owner: {
        kind: "Application",
        name: "shop",
        namespace: "argocd",
        to: { to: "/" },
      },
      warning: warning ? { key: "argoOutOfSync", values: {} } : null,
    },
  }) as unknown as Delivery;

const route = {
  host: "shop.example.com",
  path: "/",
  tls: true,
  source: {
    kind: "IngressRoute",
    name: "front",
    namespace: "shop",
    crd: "ingressroutes.traefik.io",
  },
} as ServiceRoute;

const layers = (over: Partial<Parameters<typeof layersOf>[0]> = {}) =>
  layersOf({
    queries: [cart],
    deliveries: { of: () => [delivered(false)], error: null },
    services: [{ namespace: "shop", name: "web" }],
    routes: { of: new Map([["shop/web", [route]]]), error: null },
    groupOf: (namespace) => (namespace === "shop" ? "shop" : null),
    t,
    ...over,
  });

describe("what the integrations add to the map", () => {
  /** An Argo CD Application drawn beside what it delivers, outside every group where its namespace is not drawn. */
  it("draws who delivered an object, pointing at it", () => {
    const { nodes, edges } = layers();
    const owner = nodes.find((each) => each.node.kind === "Application")!;
    expect(owner.node.group).toBeNull();
    expect(edges).toContainEqual(
      expect.objectContaining({
        from: owner.node.id,
        to: "apps/Deployment/shop/cart",
      })
    );
  });

  /** A Traefik IngressRoute into a Service is a way in the backend never draws; without it a cluster whose edge is CRDs reads as reached by nothing. */
  it("draws a vendor route into the Service it reaches", () => {
    const { nodes, edges } = layers();
    const front = nodes.find((each) => each.node.kind === "IngressRoute")!;
    expect(front.node.id).toBe("traefik.io/IngressRoute/shop/front");
    expect(front.node.group).toBe("shop");
    expect(edges).toContainEqual(
      expect.objectContaining({ from: front.node.id, to: "/Service/shop/web" })
    );
  });

  /** An installed vendor that did not answer is said to be unread: silence here reads as "nothing delivered this". */
  it("says when an installed vendor did not answer", () => {
    const { unread, nodes } = layers({
      deliveries: {
        of: () => [],
        error: new Error("applications.argoproj.io is forbidden"),
      },
    });
    expect(unread.join(" ")).toContain("applications.argoproj.io is forbidden");
    expect(nodes.some((each) => each.node.kind === "Application")).toBe(false);
  });
});

describe("asking the vendors about the map", () => {
  /**
   * Every batch of the first draw asked every vendor about the whole cluster
   * again. Fails if the vendors are asked about anything before the map is
   * drawn whole, or not asked once it is.
   */
  it("asks nothing until the map is drawn whole", () => {
    asked.deliveries.length = 0;
    asked.routes.length = 0;
    const node = {
      id: "apps/Deployment/shop/cart",
      ref: {
        kind: "Deployment",
        name: "cart",
        namespace: "shop",
        existence: "present",
        facts: null,
      },
      labels: { app: "cart" },
      annotations: {},
    } as unknown as TopologyNode;
    const nodes = new Map([[node.id, node]]);
    const services = [{ namespace: "shop", name: "cart" }];
    const { rerender } = renderHook(
      ({ whole }) => useVendorLayers(nodes, services, () => "shop", t, whole),
      { initialProps: { whole: false } }
    );
    expect(asked.deliveries.flat()).toEqual([]);
    expect(asked.routes.flat()).toEqual([]);
    rerender({ whole: true });
    expect(asked.deliveries.at(-1)).toHaveLength(1);
    expect(asked.routes.at(-1)).toEqual(services);
  });
});
