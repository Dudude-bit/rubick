import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

const capability = vi.fn();
vi.mock("@/integrations", () => ({
  useCapabilityState: () => capability(),
}));

import { AlertsAbout } from "./AlertsAbout";

const wrap = (ui: ReactNode) =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>
  );

describe("what is firing about this object", () => {
  /**
   * A read that failed is not a workload with nothing firing about it, and
   * the block drew byte-identical nothing for both — on the page where "no
   * alert" is the fact a reader leans on.
   */
  it("says the read failed rather than drawing the same nothing", async () => {
    capability.mockReturnValue({
      state: "ready",
      use: () => Promise.reject(new Error("prometheus refused")),
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
      use: async () => [{ rule: "PodCrashLooping", state: "firing", via: {} }],
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
      use: async () => [{ rule: "PodCrashLooping", state: "firing", via: {} }],
    });

    wrap(<AlertsAbout kind="Deployment" name="payments" namespace="shop" />);

    await waitFor(() =>
      expect(screen.getByText("PodCrashLooping")).toBeVisible()
    );
    expect(screen.queryByRole("link")).toBeNull();
  });

  /** Nothing firing and nothing to say is still nothing on the page. */
  it("draws nothing when nothing is firing", async () => {
    capability.mockReturnValue({ state: "ready", use: async () => [] });

    const { container } = wrap(
      <AlertsAbout kind="Deployment" name="payments" namespace="shop" />
    );

    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
