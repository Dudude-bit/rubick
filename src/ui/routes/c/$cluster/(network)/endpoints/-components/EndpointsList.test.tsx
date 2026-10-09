import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";

import { DataTable } from "@/components/ui/data-table";
import type { EndpointsInfo, ServicePublished } from "@/generated/types";
import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import { renderWithRouter } from "@/test/render";
import { Backing } from "../../-components/service-backing";
import { columns } from "./EndpointsList";

/** unready-demo as `list_endpoints_in` returns it: two pods failing readiness. */
const unreadyDemo: EndpointsInfo = {
  name: "unready-demo",
  namespace: "k8s-gui-test",
  subsets: [
    {
      addresses: [],
      notReadyAddresses: [
        {
          ip: "192.168.0.100",
          hostname: null,
          nodeName: "controlplane",
          targetRef: {
            kind: "Pod",
            name: "unready-demo-6d4f8b7c9-2xkqp",
            namespace: "k8s-gui-test",
          },
        },
        {
          ip: "192.168.1.187",
          hostname: null,
          nodeName: "node01",
          targetRef: {
            kind: "Pod",
            name: "unready-demo-6d4f8b7c9-9mzrt",
            namespace: "k8s-gui-test",
          },
        },
      ],
      ports: [{ name: "http", port: 8080, protocol: "TCP" }],
    },
  ],
  createdAt: null,
  overCapacity: false,
};

describe("the Endpoints list's IPs column", () => {
  /** unready-demo read "2 not ready" beside IPs "none", dropping two known addresses. Fails if an unready address stops counting as an address. */
  it("counts the addresses that are not ready", async () => {
    await renderWithRouter(
      <DataTable columns={columns()} data={[unreadyDemo]} />
    );
    const cell = screen
      .getAllByRole("cell")
      .find((at) => at.textContent === "2");
    expect(cell).toBeDefined();
    expect(within(cell!).queryByText("none")).toBeNull();
  });

  /** The shared file states the same addresses, each marked. */
  it("names each unready address in the shared text", () => {
    const ips = columns().find((column) => column.id === "addresses")!;
    const share = ips.meta!.share as (
      row: EndpointsInfo,
      t: T
    ) => { text: string };
    expect(share(unreadyDemo, translate.bind(null, "en") as T).text).toBe(
      "192.168.0.100 (not ready), 192.168.1.187 (not ready)"
    );
  });
});

describe("the Endpoints list's Endpoints column", () => {
  const service = {
    kind: "Service",
    name: "unready-demo",
    namespace: "k8s-gui-test",
    existence: "present" as const,
    facts: null,
  };
  const published = (
    why: "podsUnread" | "failingReadiness"
  ): ServicePublished => ({
    service,
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
    stop: {
      reason: "noneReady",
      service,
      selector: "app=unready-demo",
      pods: 2,
      why,
    },
  });
  const listed = (why: "podsUnread" | "failingReadiness") =>
    renderWithRouter(
      <Backing.Provider
        value={{ published: () => published(why), why: () => null }}
      >
        <DataTable columns={columns()} data={[unreadyDemo]} />
      </Backing.Provider>
    );

  /**
   * Marco's ledger, pods unread: its row drew an amber "1 not ready" while
   * its page and peek said grey "none ready" with the not-read mark. Fails
   * if the row draws a fault's colour, or loses the mark, there.
   */
  it("draws addresses not ready with the not-read mark while the Service's pods are unread", async () => {
    await listed("podsUnread");
    const pill = screen.getByText("2 not ready");
    expect(pill).not.toHaveClass("text-warn");
    expect(
      within(pill).getByRole("img", { name: "pods not read" })
    ).toBeInTheDocument();
  });

  /** Fails if addresses its pods do explain lose the amber the page draws them in. */
  it("draws addresses not ready amber once the Service's pods were read", async () => {
    await listed("failingReadiness");
    const pill = screen.getByText("2 not ready");
    expect(pill).toHaveClass("text-warn");
    expect(within(pill).queryByRole("img")).toBeNull();
  });
});
