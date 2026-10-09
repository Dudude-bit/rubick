import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { screen } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";

import type {
  EndpointsInfo,
  ResourceConnections,
  ServicePublished,
} from "@/generated/types";
import { ROLE_TEXT } from "@/lib/status-role";
import { useClusterStore } from "@/stores/clusterStore";
import { renderWithRouter } from "@/test/render";
import { EndpointsDetail } from "./EndpointsDetail";

const LEDGER: EndpointsInfo = {
  name: "ledger",
  namespace: "team-blind",
  createdAt: null,
  overCapacity: false,
  subsets: [
    {
      addresses: [],
      notReadyAddresses: [
        {
          ip: "10.42.1.143",
          hostname: null,
          nodeName: "k3d-rubick-live-agent-0",
          targetRef: {
            kind: "Pod",
            name: "ledger-76bccd5b44-499fh",
            namespace: "team-blind",
          },
        },
      ],
      ports: [{ name: null, port: 8080, protocol: "TCP" }],
    },
  ],
};

const neighbourhood = (
  why: "podsUnread" | "failingReadiness"
): ResourceConnections => {
  const service = {
    kind: "Service",
    name: "ledger",
    namespace: "team-blind",
    existence: "present" as const,
    facts: null,
  };
  const published: ServicePublished = {
    service,
    source: "slices",
    slices: 1,
    ready: 0,
    draining: 0,
    notReady: 1,
    unrouted: 0,
    unroutedReady: 0,
    ports: [],
    endpoints: [],
    whole: true,
    unpublished: [],
    stop: {
      reason: "noneReady",
      service,
      selector: "app=ledger",
      pods: 1,
      why,
    },
  };
  return {
    subject: service,
    edges: [],
    stops: [],
    published: [published],
    notLookedAt: [],
  };
};

let why: "podsUnread" | "failingReadiness" = "podsUnread";

beforeEach(() => {
  vi.mocked(invoke).mockImplementation(async (command: string) => {
    if (command === "get_endpoints") return LEDGER;
    if (command === "get_resource_connections") return neighbourhood(why);
    if (command.startsWith("subscribe_")) return "stream";
    if (command.startsWith("list_")) return [];
    return undefined;
  });
  useClusterStore.setState({ currentContext: "prod", isConnected: true });
});

afterEach(() => {
  vi.mocked(invoke).mockImplementation(async () => undefined);
  useClusterStore.setState({ currentContext: null, isConnected: false });
});

const open = () =>
  renderWithRouter(<EndpointsDetail />, {
    at: "/c/prod/endpoints/team-blind/ledger",
    route: "/c/$cluster/endpoints/$namespace/$name",
  });

/** The header's count, not the Backends tab's heading that says the same. */
const headerCounts = async () =>
  (await screen.findAllByText("0 ready · 1 not ready")).find((element) =>
    element.className.includes("text-[11px]")
  );

/**
 * Marco's ledger, where he cannot read pods: its peek's header said grey
 * "none ready" with the not-read mark while its page's header said amber
 * "0 ready · 1 not ready". Fails if the page's header draws a fault its
 * peek does not, or loses the Service's verdict.
 */
it("draws its header as its peek does while the pods are unread, without amber", async () => {
  why = "podsUnread";
  await open();

  const counts = await headerCounts();
  expect(counts).toBeDefined();
  expect(counts).not.toHaveClass("text-warn");
  expect(screen.getAllByText("none ready").length).toBeGreaterThan(0);
});

/** Fails if a not-ready address its pods do explain loses the amber the list draws it in. */
it("draws a not-ready address in amber once its pods were read", async () => {
  why = "failingReadiness";
  await open();

  expect(await headerCounts()).toHaveClass("text-warn");
});

/**
 * Marco's ledger, pods unread: beside the grey header, its Backends row was
 * an amber "Not ready" with a warning icon. Fails if the row draws a fault's
 * colour or loses the not-read mark while the pods were not read.
 */
it("draws a not-ready address's row with the not-read mark while the pods are unread", async () => {
  why = "podsUnread";
  await open();

  const badge = await screen.findByText("Not ready");
  expect(badge).toHaveClass(ROLE_TEXT.neutral);
  expect(badge.querySelector("svg")).toHaveClass("lucide-eye-off");
});

/** Fails if a not-ready address its pods do explain loses its amber row. */
it("draws a not-ready address's row amber once its pods were read", async () => {
  why = "failingReadiness";
  await open();

  expect(await screen.findByText("Not ready")).toHaveClass(ROLE_TEXT.warn);
});

/**
 * Marco's ledger, pods unread: its Overview's "Not ready 1" was amber beside
 * a grey Status. Fails if the count draws a fault's colour or loses the
 * not-read mark while the pods were not read.
 */
it("draws the Overview's not-ready count with the not-read mark while the pods are unread", async () => {
  why = "podsUnread";
  await renderWithRouter(<EndpointsDetail />, {
    at: "/c/prod/endpoints/team-blind/ledger?tab=overview",
    route: "/c/$cluster/endpoints/$namespace/$name",
  });

  const mark = await screen.findByRole("img", { name: "pods not read" });
  expect(mark.parentElement).toHaveTextContent("1");
  expect(mark.parentElement).not.toHaveClass("text-warn");
});
