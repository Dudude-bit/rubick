import { screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { CatalogEntry } from "@/generated/types";
import { useClusterStore } from "@/stores/clusterStore";
import { renderWithRouter } from "@/test/render";

const entry = (group: string, plural: string, kind: string): CatalogEntry => ({
  group,
  version: "v1",
  kind,
  plural,
  namespaced: true,
  verbs: ["get", "list"],
});

const HPA = {
  metadata: { name: "api", namespace: "shop" },
  spec: {
    scaleTargetRef: { apiVersion: "apps/v1", kind: "Deployment", name: "api" },
  },
};

vi.mock("@/lib/commands", () => ({
  commands: {
    listApiCatalog: () =>
      Promise.resolve({
        entries: [
          entry(
            "autoscaling",
            "horizontalpodautoscalers",
            "HorizontalPodAutoscaler"
          ),
          entry("apps", "deployments", "Deployment"),
        ],
        unread: [],
      }),
    getServedObject: () => Promise.resolve(HPA),
    listServedObjects: () =>
      Promise.resolve({ items: [HPA], truncated: false }),
  },
}));

const { AttachedFrom, AttachedGate } = await import("./Attached");

beforeEach(() => {
  useClusterStore.setState({ currentContext: "test", isConnected: true });
});

const gate = (
  <AttachedGate resource="horizontalpodautoscalers" namespace="shop" name="api">
    <p>its own page</p>
  </AttachedGate>
);

describe("an attached object's address", () => {
  /**
   * The parent opens in its place, by replace, and remembers where it came
   * from so the object itself stays one click away.
   */
  it("opens its one parent and says which object it came from", async () => {
    const { router } = await renderWithRouter(gate, {
      at: "/c/test/horizontalpodautoscalers/shop/api",
    });
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(
        "/c/test/deployments/shop/api"
      )
    );
    expect(router.state.location.search).toEqual({
      via: "horizontalpodautoscalers/shop/api",
    });
  });

  /** Without a way to stay, the object's own page could never be read. */
  it("stays on the object when asked to", async () => {
    const { router } = await renderWithRouter(gate, {
      at: "/c/test/horizontalpodautoscalers/shop/api?view=own",
    });
    expect(await screen.findByText("its own page")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(
      "/c/test/horizontalpodautoscalers/shop/api"
    );
  });

  it("leads back from the parent to the object on its own page", async () => {
    await renderWithRouter(<AttachedFrom />, {
      at: "/c/test/deployments/shop/api?via=horizontalpodautoscalers/shop/api",
    });
    expect(
      screen.getByRole("link", { name: "Open it on its own page" })
    ).toHaveAttribute(
      "href",
      "/c/test/horizontalpodautoscalers/shop/api?view=own"
    );
  });
});
