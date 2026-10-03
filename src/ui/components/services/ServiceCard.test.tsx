import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import {
  ScreenShareProvider,
  useScreenSections,
} from "@/components/share/screen-share";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { ChainPath } from "@/lib/connections";

const chain = vi.hoisted(() => ({ paths: [] as ChainPath[] }));
const read = vi.hoisted(() => ({ error: null as unknown }));

vi.mock("@/hooks/useConnections", () => ({
  useConnections: () => ({
    data: read.error
      ? undefined
      : {
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
    error: read.error,
    isPending: false,
  }),
}));

vi.mock("@/lib/connections", async (original) => ({
  ...(await original<typeof import("@/lib/connections")>()),
  trafficChains: () => chain.paths,
}));

import { ServiceCard } from "./ServiceCard";
import { pinShare } from "./service-card-share";
import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";

const t: T = (section, key, values) => translate("en", section, key, values);

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

beforeEach(() => {
  read.error = null;
});

describe("what a card says about its state", () => {
  /**
   * The card handed the state only the message, and the code the backend
   * sent with it was lost on the way: a deleted Deployment read as "could
   * not read" rather than as gone.
   */
  it("says a pinned workload the cluster no longer has is gone", () => {
    const said = "Resource not found: Deployment/payments in namespace shop";
    read.error = new Error(
      `Tauri command 'getResourceConnections' failed: ${said}`,
      { cause: { code: "NOT_FOUND", message: said } }
    );

    mount();

    expect(screen.getByText(/does not exist|не существует/i)).toBeVisible();
  });
});

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
              unroutedReady: 0,
              ports: [],
              endpoints: [],
              whole: true,
              unpublished: [],
              stop: null,
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

describe("what a card offers Share", () => {
  /** Deleting the `ref` on the name row breaks this: a pinned service's
   *  card would offer a section with no way back to the object it is about. */
  it("carries a ref back to the pinned object on the name row", () => {
    const section = pinShare(
      pin,
      { state: "ready", ready: 2, total: 2 },
      { entries: [], known: true },
      [],
      null,
      [],
      t
    );
    expect(section.body.type).toBe("facts");
    const rows = section.body.type === "facts" ? section.body.rows : [];
    expect(rows[0]).toMatchObject({
      values: [
        { text: "payments", ref: { kind: "Deployment", stem: "payments" } },
      ],
    });
    expect(rows[1]).toMatchObject({ values: [{ role: "ok" }] });
  });

  /** A service this app could not read at all must not offer the rest of
   *  the card's fields as though they were answers. */
  it("marks the whole section unread when the neighbourhood could not be read", () => {
    const section = pinShare(
      pin,
      { state: "unread", why: "Forbidden" },
      { entries: [], known: false },
      [],
      null,
      [],
      t
    );
    expect(section.unread).toBe("Forbidden");
  });

  it("registers into the screen's Share while the card is mounted", () => {
    let collect = null as ReturnType<typeof useScreenSections>;
    function Probe() {
      collect = useScreenSections();
      return null;
    }
    render(
      <MemoryRouter>
        <TooltipProvider>
          <ScreenShareProvider>
            <ServiceCard pin={pin} onUnpin={() => {}} />
            <Probe />
          </ScreenShareProvider>
        </TooltipProvider>
      </MemoryRouter>
    );
    const sections = collect?.() ?? [];
    expect(
      sections.some(
        (section) =>
          section.id === `pin:${pin.kind}/${pin.namespace}/${pin.name}`
      )
    ).toBe(true);
  });
});
