import { screen } from "@testing-library/react";
import { expect, it } from "vite-plus/test";

import type { ServicePublished } from "@/generated/types";
import type { ConnectionsRead } from "@/hooks/useConnections";
import { renderWithRouter } from "@/test/render";
import { PublishedEndpoints } from "./PublishedEndpoints";

const subject = {
  kind: "Service",
  name: "ledger",
  namespace: "team-blind",
  existence: "present" as const,
  facts: null,
};

const ledger = (why: "podsUnread" | "failingReadiness"): ConnectionsRead =>
  ({
    data: {
      subject,
      edges: [],
      stops: [],
      notLookedAt: [],
      published: [
        {
          service: subject,
          source: "slices",
          slices: 1,
          ready: 0,
          draining: 0,
          notReady: 1,
          unrouted: 0,
          unroutedReady: 0,
          ports: [],
          whole: true,
          unpublished: [],
          stop: {
            reason: "noneReady",
            service: subject,
            selector: "app=ledger",
            pods: 1,
            why,
            cause: null,
          },
          endpoints: [
            {
              address: "10.42.1.30",
              target: null,
              ready: false,
              serving: false,
              terminating: false,
              nodeName: null,
              zone: null,
              hintZones: [],
              ports: [8080],
            },
          ],
        } satisfies ServicePublished,
      ],
    },
    error: null,
    isPending: false,
  }) as unknown as ConnectionsRead;

/**
 * Marco's ledger, pods unread: the Service page's Endpoints tab drew the
 * address "not ready" amber under a grey header. Fails if the State column
 * takes a fault's colour, or loses the not-read mark, while the pods are unread.
 */
it("draws an address not ready with the not-read mark while the Service's pods are unread", async () => {
  await renderWithRouter(<PublishedEndpoints query={ledger("podsUnread")} />);
  const mark = screen.getByRole("img", { name: "pods not read" });
  expect(mark.closest("td")).toHaveTextContent("not ready");
  expect(mark.closest("td")).not.toHaveClass("text-warn");
});

/** Fails if an address its pods do explain loses its amber on the tab. */
it("draws an address not ready amber once the Service's pods were read", async () => {
  await renderWithRouter(
    <PublishedEndpoints query={ledger("failingReadiness")} />
  );
  expect(screen.queryByRole("img", { name: "pods not read" })).toBeNull();
  expect(screen.getByText("not ready").closest("td")).toHaveClass("text-warn");
});
