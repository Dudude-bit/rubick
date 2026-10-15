import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { screen } from "@testing-library/react";

import {
  ScreenShareProvider,
  useScreenSections,
} from "@/components/share/screen-share";
import type { ChainPath } from "@/lib/connections";
import { renderWithRouter } from "@/test/render";

const chain = vi.hoisted(() => ({ paths: [] as ChainPath[] }));
const read = vi.hoisted(() => ({
  error: null as unknown,
  workload: { replicas: 1, readyReplicas: 1, rollout: null as unknown },
}));

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
              ...read.workload,
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
import { useLocaleStore } from "@/stores/localeStore";
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
  renderWithRouter(<ServiceCard pin={pin} onUnpin={() => {}} />, {
    at: "/c/prod",
    route: "/c/$cluster",
  });

beforeEach(() => {
  read.error = null;
  read.workload = { replicas: 1, readyReplicas: 1, rollout: null };
});

describe("what a card says about its state", () => {
  /**
   * The card handed the state only the message, and the code the backend
   * sent with it was lost on the way: a deleted Deployment read as "could
   * not read" rather than as gone.
   */
  it("says a pinned workload the cluster no longer has is gone", async () => {
    const said = "Resource not found: Deployment/payments in namespace shop";
    read.error = new Error(
      `Tauri command 'getResourceConnections' failed: ${said}`,
      { cause: { code: "NOT_FOUND", message: said } }
    );

    await mount();

    expect(screen.getByText(/does not exist|не существует/i)).toBeVisible();
  });
});

describe("what a card says about a rollout", () => {
  /**
   * A stalled Deployment's card drew the badge "Stalled" among Russian
   * words. Fails if the badge goes back to the code.
   */
  it("words the rollout verdict in the reader's language", async () => {
    read.workload = {
      replicas: 2,
      readyReplicas: 0,
      rollout: { state: "stalled", message: null, serving: 0 },
    };
    useLocaleStore.setState({ choice: "ru" });
    try {
      await mount();
      expect(screen.getByText("Застрял")).toBeVisible();
      expect(screen.queryByText("Stalled")).toBeNull();
    } finally {
      useLocaleStore.setState({ choice: null });
    }
  });
});

describe("what a card says about a way in", () => {
  /**
   * The thesis of this app, on the card that summarises it. An address
   * whose backing nobody read drew exactly like one confirmed to be
   * serving — and an address is the entry a reader would actually click,
   * which is the one that is never known until a published hop matches it.
   */
  it("says the backing was not read rather than drawing it as working", async () => {
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
            address: null,
          },
        ],
      },
    ] as unknown as ChainPath[];

    await mount();

    expect(screen.getByText("https://shop.example.com")).toBeVisible();
    expect(screen.getByText(/not read yet|не читали/i)).toBeVisible();
  });

  /** And a Service read to have nothing behind it still says so, in warning. */
  it("keeps saying when a service really has nothing behind it", async () => {
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

    await mount();

    expect(screen.getByText(/nothing behind|ничего нет/i)).toBeVisible();
  });

  const shutChain = (): ChainPath[] => {
    const service = {
      kind: "Service",
      name: "payments",
      namespace: "shop",
      existence: "present",
      facts: null,
    };
    return [
      {
        key: "c",
        broken: true,
        hops: [
          {
            at: "published",
            published: {
              service,
              source: "slices",
              slices: 1,
              ready: 2,
              draining: 0,
              notReady: 0,
              unrouted: 0,
              unroutedReady: 0,
              ports: [],
              endpoints: [],
              whole: true,
              unpublished: [],
              stop: {
                reason: "policyRefuses",
                service,
                policies: ["deny-all"],
                ports: [8080],
                noRules: true,
                client: null,
              },
            },
            first: null,
            address: null,
            summary: "",
            tone: "ok",
          },
        ],
      },
    ] as unknown as ChainPath[];
  };

  /** Ready pods behind a policy that admits nobody drew the way in as live. */
  it("says a way in a policy shuts is shut, in red", async () => {
    chain.paths = shutChain();

    await mount();

    const word = screen.getByText(
      /^(shut by NetworkPolicy|закрыто NetworkPolicy)$/
    );
    expect(word).toHaveClass("text-err");
    expect(screen.queryByText(/nothing behind|ничего нет/i)).toBeNull();
  });

  /** The header read "1/1 ready" in green over the only way in, shut. */
  it("says in the header that every way in is shut, and stops calling the count green", async () => {
    chain.paths = shutChain();
    await mount();
    expect(
      screen.getByText(
        /^(every way in shut by NetworkPolicy|все входы закрыты NetworkPolicy)$/
      )
    ).toHaveClass("text-err");
    expect(screen.getByText("1/1 ready")).not.toHaveClass("text-ok");
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

  /** The Share listed every way in bare, beside a card that said one was
   *  shut and another had nothing behind it. */
  it("says beside each way in what the card says beside it", () => {
    const way = {
      url: null,
      detail: null,
      servingKnown: true,
      unsure: false,
      address: null,
    };
    const section = pinShare(
      pin,
      { state: "ready", ready: 2, total: 2 },
      {
        entries: [
          { ...way, key: "a", label: "web", serving: false, shut: true },
          { ...way, key: "b", label: "api", serving: false, shut: false },
          { ...way, key: "c", label: "shop", serving: true, shut: false },
          {
            ...way,
            key: "d",
            label: "edge",
            serving: false,
            servingKnown: false,
            shut: false,
            unsure: true,
          },
          {
            ...way,
            key: "e",
            label: "cold",
            serving: true,
            shut: false,
            address: "noController",
          },
        ],
        known: true,
      },
      [],
      null,
      [],
      t
    );
    const rows = section.body.type === "facts" ? section.body.rows : [];
    expect(rows[2]).toMatchObject({
      values: [
        {
          text: "web (shut by NetworkPolicy), api (nothing behind it), shop, edge (not checked), cold (nothing serves its class)",
        },
      ],
    });
  });

  /** The Share filed a service whose every way in was shut as ready, in green. */
  it("says in the status that every way in is shut, as the header does", () => {
    const way = {
      url: null,
      detail: null,
      serving: false,
      servingKnown: true,
      shut: true,
      unsure: false,
      address: null,
    };
    const section = pinShare(
      pin,
      { state: "ready", ready: 2, total: 2 },
      {
        entries: [
          { ...way, key: "a", label: "web" },
          { ...way, key: "b", label: "api" },
        ],
        known: true,
      },
      [],
      null,
      [],
      t
    );
    const rows = section.body.type === "facts" ? section.body.rows : [];
    expect(rows[1]).toMatchObject({
      values: [
        { text: "2/2 ready · every way in shut by NetworkPolicy", role: "err" },
      ],
    });
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

  it("registers into the screen's Share while the card is mounted", async () => {
    let collect = null as ReturnType<typeof useScreenSections>;
    function Probe() {
      collect = useScreenSections();
      return null;
    }
    await renderWithRouter(
      <ScreenShareProvider>
        <ServiceCard pin={pin} onUnpin={() => {}} />
        <Probe />
      </ScreenShareProvider>,
      { at: "/c/prod", route: "/c/$cluster" }
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
