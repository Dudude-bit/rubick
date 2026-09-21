import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

const capability = vi.fn();
const speaks = vi.fn((_kind: string) => true);
vi.mock("@/integrations", () => ({
  useCapabilityState: () => capability(),
  alertsCanBeAbout: (kind: string) => speaks(kind),
}));

import { AlertsAbout } from "./AlertsAbout";

const wrap = (ui: ReactNode, client?: QueryClient) =>
  render(
    <QueryClientProvider
      client={
        client ??
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>
  );

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

    wrap(<AlertsAbout kind="Deployment" name="payments" namespace="shop" />);

    await waitFor(() =>
      expect(screen.getByText(/could not be read/i)).toBeVisible()
    );
  });

  /** And a Prometheus that never answered is its own sentence. */
  it("says the connected Prometheus did not answer", () => {
    capability.mockReturnValue({ state: "unreachable", reason: "timed out" });

    wrap(<AlertsAbout kind="Deployment" name="payments" namespace="shop" />);

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
      page: "/integrations/mimir?tab=alerts",
      use: {
        read: async () => [],
        pick: () => [{ rule: "PodCrashLooping", state: "firing", via: {} }],
      },
    });

    wrap(<AlertsAbout kind="Deployment" name="payments" namespace="shop" />);

    const link = await screen.findByRole("link");
    expect(link).toHaveAttribute("href", "/integrations/mimir?tab=alerts");
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

    wrap(<AlertsAbout kind="Deployment" name="payments" namespace="shop" />);

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
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    wrap(
      <AlertsAbout kind="Deployment" name="payments" namespace="shop" />,
      client
    );
    wrap(
      <AlertsAbout kind="Deployment" name="checkout" namespace="shop" />,
      client
    );
    wrap(
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

    const { container } = wrap(
      <AlertsAbout kind="ConfigMap" name="settings" namespace="shop" />
    );

    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(read).not.toHaveBeenCalled();
  });

  /** Nothing firing and nothing to say is still nothing on the page. */
  it("draws nothing when nothing is firing", async () => {
    capability.mockReturnValue({
      state: "ready",
      use: { read: async () => [], pick: () => [] },
    });

    const { container } = wrap(
      <AlertsAbout kind="Deployment" name="payments" namespace="shop" />
    );

    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
