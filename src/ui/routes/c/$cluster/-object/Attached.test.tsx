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
  shortNames: [],
});

const HPA = {
  metadata: { name: "api", namespace: "shop" },
  spec: {
    scaleTargetRef: { apiVersion: "apps/v1", kind: "Deployment", name: "api" },
  },
};

const EVENT = {
  metadata: { name: "api.18dc", namespace: "shop" },
  involvedObject: {
    apiVersion: "autoscaling/v2",
    kind: "HorizontalPodAutoscaler",
    name: "api",
    namespace: "shop",
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
    getServedObject: (_group: string, plural: string) =>
      Promise.resolve(plural === "events" ? EVENT : HPA),
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

  /**
   * A deep link to an Event about an HPA went on through the HPA to its
   * Deployment, whose Events tab has none of the HPA's events. Fails if the
   * Event's redirect lets the HPA redirect again.
   */
  it("opens an Event about an attached object on that object's own Events tab", async () => {
    const { router } = await renderWithRouter(
      <AttachedGate resource="events" namespace="shop" name="api.18dc">
        <p>the event</p>
      </AttachedGate>,
      { at: "/c/test/events/shop/api.18dc" }
    );
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(
        "/c/test/horizontalpodautoscalers/shop/api"
      )
    );
    expect(router.state.location.search).toEqual({
      tab: "events",
      via: "events/shop/api.18dc",
      view: "own",
    });
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
