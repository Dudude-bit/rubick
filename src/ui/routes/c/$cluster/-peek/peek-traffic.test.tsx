import { describe, expect, it, vi } from "vite-plus/test";
import { screen } from "@testing-library/react";

import type {
  ChainStop,
  ObjectRef,
  ResourceConnections,
} from "@/generated/types";

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

describe("the peek says where a Service's path stops", () => {
  const stoppedAt = (stop: (service: ObjectRef) => ChainStop) => {
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
            stop: stop(service),
          },
        ],
      });
    return draw("Service", "checkout-api");
  };

  /** The peek drew the step behind a Service whose pods the API server
   *  refuses as "the addresses actually answering", grey, beside a red
   *  Status row. Fails if the step stops saying the stop. */
  it("draws the step behind a refused Service red, in the stop's words", async () => {
    await stoppedAt((service) => ({
      reason: "podsRefused",
      service,
      selector: "app=checkout-api",
      workloads: [at("Deployment", "checkout-api")],
      said: 'pods "checkout-api-7d9" is forbidden: exceeded quota: two-pods',
    }));
    const words = await screen.findByText("pods refused");
    expect(words).toHaveClass("text-err");
    expect(document.body.textContent).not.toContain("actually answering");
    expect(document.querySelectorAll(".border-err")).toHaveLength(1);
  });

  /** A Service scaled to zero is idle, not down: the trace draws it grey. */
  it("draws the step behind a Service scaled to zero quiet", async () => {
    await stoppedAt((service) => ({
      reason: "scaledToZero",
      service,
      selector: "app=checkout-api",
      workloads: [at("Deployment", "checkout-api")],
    }));
    expect(await screen.findByText("scaled to zero")).toBeInTheDocument();
    expect(document.querySelectorAll(".border-err, .text-err")).toHaveLength(0);
  });
});
