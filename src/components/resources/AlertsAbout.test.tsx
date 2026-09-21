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

  /** Nothing firing and nothing to say is still nothing on the page. */
  it("draws nothing when nothing is firing", async () => {
    capability.mockReturnValue({ state: "ready", use: async () => [] });

    const { container } = wrap(
      <AlertsAbout kind="Deployment" name="payments" namespace="shop" />
    );

    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
