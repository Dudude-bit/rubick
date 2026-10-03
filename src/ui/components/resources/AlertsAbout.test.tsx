import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import type { QueryClient } from "@tanstack/react-query";

const capability = vi.fn();
const speaks = vi.fn((_kind: string) => true);
vi.mock("@/integrations", () => ({
  useCapabilityState: () => capability(),
  alertsCanBeAbout: (kind: string) => speaks(kind),
}));

import { testQueryClient, renderWithRouter } from "@/test/render";
import { vendorLink } from "@/lib/links";
import { AlertsAbout } from "./AlertsAbout";

const wrap = (ui: ReactElement, client?: QueryClient) =>
  renderWithRouter(<div data-testid="slot">{ui}</div>, {
    client,
    at: "/c/prod/deployments/shop/payments",
    route: "/c/$cluster/$resource/$namespace/$name",
  });

describe("what is firing about this object", () => {
  beforeEach(() => speaks.mockReturnValue(true));

  /**
   * A read that failed is not a workload with nothing firing about it, and
   * the block drew byte-identical nothing for both — on the page where "no
   * alert" is the fact a reader leans on.
   */
  it("says the read failed rather than drawing the same nothing", async () => {
    capability.mockReturnValue({
      state: "ready",
      use: { read: () => Promise.reject(new Error("prometheus refused")) },
    });

    await wrap(
      <AlertsAbout kind="Deployment" name="payments" namespace="shop" />
    );

    await waitFor(() =>
      expect(screen.getByText(/could not be read/i)).toBeVisible()
    );
  });

  /** And a Prometheus that never answered is its own sentence. */
  it("says the connected Prometheus did not answer", async () => {
    capability.mockReturnValue({ state: "unreachable", reason: "timed out" });

    await wrap(
      <AlertsAbout kind="Deployment" name="payments" namespace="shop" />
    );

    expect(screen.getByText(/did not answer/i)).toBeVisible();
  });

  /**
   * The "open" link is the supplier's own route, and only where the supplier
   * said it has one. Spelling `/integrations/prometheus?tab=alerts` here
   * named a vendor from outside the seam, and pointed at Prometheus for
   * whatever answers next.
   */
  it("sends the reader where the supplier says its alerts are", async () => {
    capability.mockReturnValue({
      state: "ready",
      page: vendorLink("mimir", { tab: "alerts" }),
      use: {
        read: async () => [],
        pick: () => [{ rule: "PodCrashLooping", state: "firing", via: {} }],
      },
    });

    await wrap(
      <AlertsAbout kind="Deployment" name="payments" namespace="shop" />
    );

    const link = await screen.findByRole("link");
    expect(link).toHaveAttribute(
      "href",
      "/c/prod/integrations/mimir?tab=alerts"
    );
  });

  /** A supplier with no screen of its own offers no link at all. */
  it("offers no link where the supplier has no page", async () => {
    capability.mockReturnValue({
      state: "ready",
      page: null,
      use: {
        read: async () => [],
        pick: () => [{ rule: "PodCrashLooping", state: "firing", via: {} }],
      },
    });

    await wrap(
      <AlertsAbout kind="Deployment" name="payments" namespace="shop" />
    );

    await waitFor(() =>
      expect(screen.getByText("PodCrashLooping")).toBeVisible()
    );
    expect(screen.queryByRole("link")).toBeNull();
  });

  /**
   * The evaluator hands over every alerting rule it has — the block wants a
   * slice of that, not a read of its own. Keying the query by object put the
   * whole collection on the wire for each page opened, each peek and each
   * poll.
   */
  it("reads the evaluator once for every object on the screen", async () => {
    const read = vi.fn(async () => []);
    capability.mockReturnValue({
      state: "ready",
      page: null,
      use: { read, pick: () => [] },
    });
    const client = testQueryClient();

    await wrap(
      <AlertsAbout kind="Deployment" name="payments" namespace="shop" />,
      client
    );
    await wrap(
      <AlertsAbout kind="Deployment" name="checkout" namespace="shop" />,
      client
    );
    await wrap(
      <AlertsAbout kind="StatefulSet" name="ledger" namespace="bank" />,
      client
    );

    await waitFor(() => expect(read).toHaveBeenCalled());
    expect(read).toHaveBeenCalledTimes(1);
  });

  /**
   * The peek draws the block for whatever is peeked, so a kind no evaluator
   * labels must get nothing — not a block, and not "the alerts could not be
   * read" over a ConfigMap either.
   */
  it("says nothing at all about a kind no evaluator labels", async () => {
    speaks.mockReturnValue(false);
    const read = vi.fn(() => Promise.reject(new Error("prometheus refused")));
    capability.mockReturnValue({
      state: "ready",
      page: null,
      use: { read, pick: () => [] },
    });

    await wrap(
      <AlertsAbout kind="ConfigMap" name="settings" namespace="shop" />
    );

    await waitFor(() =>
      expect(screen.getByTestId("slot")).toBeEmptyDOMElement()
    );
    expect(read).not.toHaveBeenCalled();
  });

  /** Nothing firing and nothing to say is still nothing on the page. */
  it("draws nothing when nothing is firing", async () => {
    capability.mockReturnValue({
      state: "ready",
      use: { read: async () => [], pick: () => [] },
    });

    await wrap(
      <AlertsAbout kind="Deployment" name="payments" namespace="shop" />
    );

    await waitFor(() =>
      expect(screen.getByTestId("slot")).toBeEmptyDOMElement()
    );
  });
});
