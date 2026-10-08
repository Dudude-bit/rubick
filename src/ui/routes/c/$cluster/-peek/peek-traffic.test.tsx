import { describe, expect, it, vi } from "vite-plus/test";
import { screen } from "@testing-library/react";

import type { ObjectRef, ResourceConnections } from "@/generated/types";

const answer = vi.hoisted(() => ({
  connections: (): Promise<ResourceConnections> =>
    Promise.reject(new Error("not set")),
}));

vi.mock("@/lib/commands", () => ({
  commands: {
    getResourceConnections: () => answer.connections(),
    listGateways: () => Promise.resolve([]),
  },
}));

const { PeekTraffic } = await import("./peek-traffic");
const { renderWithRouter } = await import("@/test/render");

const at = (kind: string, name: string): ObjectRef => ({
  kind,
  name,
  namespace: "team-checkout",
  existence: "present",
  facts: null,
});

const draw = (kind: string, name: string) =>
  renderWithRouter(
    <PeekTraffic target={{ kind, name, namespace: "team-checkout" }} />,
    { at: "/c/prod/pods", route: "/c/$cluster/$" }
  );

describe("the peek names what is one label short", () => {
  /** Marco's Service peek counted the pods one label short and never named
   *  them, while the page did. Fails if the peek drops the closest pods. */
  it("names the closest pods under a Service whose selector matches none", async () => {
    const service = at("Service", "checkout-api");
    answer.connections = () =>
      Promise.resolve({
        subject: service,
        edges: [],
        stops: [],
        notLookedAt: [],
        published: [
          {
            service,
            source: "slices",
            slices: 0,
            ready: 0,
            draining: 0,
            notReady: 0,
            unrouted: 0,
            unroutedReady: 0,
            ports: [],
            endpoints: [],
            whole: true,
            unpublished: [],
            stop: {
              reason: "selectsNothing",
              service,
              selector: "app=checkout-api,track=stable",
              near: {
                pods: [
                  at("Pod", "checkout-api-flzqq"),
                  at("Pod", "checkout-api-sstgw"),
                ],
                carries: "app=checkout-api",
                lacks: "track=stable",
              },
            },
          },
        ],
      });
    await draw("Service", "checkout-api");
    expect(
      await screen.findByRole("link", { name: /checkout-api-flzqq/ })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /checkout-api-sstgw/ })
    ).toBeInTheDocument();
    expect(document.body.textContent).toContain("add track=stable");
  });

  /** The Pod peek drew nothing at all where the page said no Service selects
   *  the pod, so the Service one label short was invisible from the peek.
   *  Fails if the peek stays quiet about it. */
  it("names the Service one label short of a pod none selects", async () => {
    answer.connections = () =>
      Promise.resolve({
        subject: at("Pod", "checkout-api-flzqq"),
        edges: [],
        stops: [],
        published: [],
        notLookedAt: [],
        nearlySelectedBy: [
          {
            service: at("Service", "checkout-api"),
            carries: "app=checkout-api",
            lacks: "track=stable",
          },
        ],
      });
    await draw("Pod", "checkout-api-flzqq");
    expect(
      await screen.findByRole("link", { name: /checkout-api/ })
    ).toBeInTheDocument();
    expect(document.body.textContent).toContain(
      "carries app=checkout-api but not track=stable"
    );
  });
});
