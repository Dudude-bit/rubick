import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { TooltipProvider } from "@/components/ui/tooltip";
import type { ChainPath } from "@/lib/connections";

const chain = vi.hoisted(() => ({ paths: [] as ChainPath[] }));

vi.mock("@/hooks/useConnections", () => ({
  useConnections: () => ({
    data: {
      subject: {
        kind: "Deployment",
        name: "payments",
        namespace: "shop",
        existence: "present",
        facts: {
          kind: "workload",
          replicas: 1,
          readyReplicas: 1,
          revision: null,
          current: null,
        },
      },
      edges: [],
      published: [],
      stops: [],
      notLookedAt: [],
    },
    error: null,
    isPending: false,
  }),
}));

vi.mock("@/lib/connections", async (original) => ({
  ...(await original<typeof import("@/lib/connections")>()),
  trafficChains: () => chain.paths,
}));

import { ServiceCard } from "./ServiceCard";

const pin = {
  context: "prod",
  kind: "Deployment",
  namespace: "shop",
  name: "payments",
  pinnedAt: 1,
};

const mount = () =>
  render(
    <MemoryRouter>
      <TooltipProvider>
        <ServiceCard pin={pin} onUnpin={() => {}} />
      </TooltipProvider>
    </MemoryRouter>
  );

describe("what a card says about a way in", () => {
  /**
   * The thesis of this app, on the card that summarises it. An address
   * whose backing nobody read drew exactly like one confirmed to be
   * serving — and an address is the entry a reader would actually click,
   * which is the one that is never known until a published hop matches it.
   */
  it("says the backing was not read rather than drawing it as working", () => {
    chain.paths = [
      {
        key: "c",
        broken: false,
        hops: [
          {
            at: "object",
            object: {
              kind: "Ingress",
              name: "shop",
              namespace: "shop",
              existence: "present",
              facts: null,
            },
            self: false,
            detail: null,
            via: null,
            urls: ["https://shop.example.com"],
            publishedAt: null,
          },
        ],
      },
    ] as unknown as ChainPath[];

    mount();

    expect(screen.getByText("https://shop.example.com")).toBeVisible();
    expect(screen.getByText(/not read yet|не читали/i)).toBeVisible();
  });

  /** And a Service read to have nothing behind it still says so, in warning. */
  it("keeps saying when a service really has nothing behind it", () => {
    chain.paths = [
      {
        key: "c",
        broken: false,
        hops: [
          {
            at: "published",
            published: {
              service: {
                kind: "Service",
                name: "payments",
                namespace: "shop",
                existence: "present",
                facts: null,
              },
              source: "slices",
              slices: 1,
              ready: 0,
              draining: 0,
              notReady: 2,
              unrouted: 0,
              ports: [],
              endpoints: [],
              whole: true,
              unpublished: [],
            },
            first: null,
            address: null,
            summary: "",
            tone: "warn",
          },
        ],
      },
    ] as unknown as ChainPath[];

    mount();

    expect(screen.getByText(/nothing behind|ничего нет/i)).toBeVisible();
  });
});
