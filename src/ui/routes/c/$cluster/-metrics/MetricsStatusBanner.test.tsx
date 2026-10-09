import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient } from "@tanstack/react-query";

vi.mock("@/lib/commands", () => ({
  commands: { recheckMetrics: vi.fn(async () => undefined) },
}));

import { commands } from "@/lib/commands";

import { renderWithProviders } from "@/test/render";
import { useClusterStore } from "@/stores/clusterStore";
import { useMetricsNoticeStore } from "@/stores/metricsNoticeStore";
import { MetricsStatusBanner } from "./MetricsStatusBanner";

const available = { status: "available" as const, message: null };
const notInstalled = {
  status: "notInstalled" as const,
  message: "404 page not found",
};

const bannerOf = (title: string) =>
  screen.getByText(title).closest('[role="status"]') as HTMLElement;

beforeEach(() => {
  useMetricsNoticeStore.setState({ hidden: {} });
  useClusterStore.setState({ currentContext: "acme-staging" });
});

describe("MetricsStatusBanner", () => {
  /**
   * One namespace of a selection refused beside one that answered leaves the
   * status "available". Without the unread namespace named, its pods' blank
   * samples looked like "not scraped yet" and no banner said otherwise.
   */
  it("names a namespace whose metrics were refused beside ones that answered", () => {
    renderWithProviders(
      <MetricsStatusBanner
        status={available}
        unread={[
          {
            namespace: "staging",
            code: "PERMISSION_DENIED",
            message:
              'pods.metrics.k8s.io is forbidden in the namespace "staging"',
          },
        ]}
      />
    );
    expect(
      screen.getByText("Could not read pod metrics in staging.")
    ).toBeInTheDocument();
  });

  /** Every namespace answered: there is nothing to say. */
  it("says nothing when every namespace answered", () => {
    const { container } = renderWithProviders(
      <MetricsStatusBanner status={available} unread={[]} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  /**
   * A newcomer read "404 page not found" as the app being broken. Fails if
   * the server's words reach the visible line, or if a missing install is
   * drawn in the red a broken workload wears.
   */
  it("says metrics-server is missing in words, with the 404 folded away", () => {
    renderWithProviders(<MetricsStatusBanner status={notInstalled} />);

    const banner = bannerOf(
      "metrics-server is not installed, so CPU and memory are not shown"
    );
    expect(screen.getByText("404 page not found")).not.toBeVisible();
    expect(banner.className).not.toContain("border-err");
  });

  /** Fails if a refusal goes back to the error tone it cannot be fixed from. */
  it("draws a refusal calmly, not as an error", () => {
    renderWithProviders(
      <MetricsStatusBanner status={{ status: "forbidden", message: null }} />
    );
    const banner = bannerOf(
      "Metrics are not readable with this access, so CPU and memory are not shown"
    );
    expect(banner.className).toContain("border-info");
    expect(banner.className).not.toContain("border-err");
  });

  /**
   * The banner sat on every page with no way to close it. Fails if hiding it
   * does not hold for the cluster, or if it hides it for every cluster.
   */
  it("can be put away for one cluster and stays away there", async () => {
    const { unmount } = renderWithProviders(
      <MetricsStatusBanner status={notInstalled} />
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Hide for this cluster" })
    );
    expect(screen.queryByText(/metrics-server is not installed/)).toBeNull();
    unmount();

    const again = renderWithProviders(
      <MetricsStatusBanner status={notInstalled} />
    );
    expect(screen.queryByText(/metrics-server is not installed/)).toBeNull();
    again.unmount();

    useClusterStore.setState({ currentContext: "acme-prod" });
    renderWithProviders(<MetricsStatusBanner status={notInstalled} />);
    expect(
      bannerOf(
        "metrics-server is not installed, so CPU and memory are not shown"
      )
    ).toBeInTheDocument();
  });

  /**
   * The backend now answers every metrics read from its five-minute memory,
   * so Check again that only refetched would read the memory back: a
   * metrics-server installed a minute ago would still say "not installed".
   */
  it("makes Check again forget the remembered answer before it reads", async () => {
    const client = new QueryClient();
    const refetch = vi.spyOn(client, "refetchQueries");
    renderWithProviders(<MetricsStatusBanner status={notInstalled} />, {
      client,
    });
    await userEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(refetch).toHaveBeenCalled());
    expect(commands.recheckMetrics).toHaveBeenCalledTimes(1);
    expect(
      vi.mocked(commands.recheckMetrics).mock.invocationCallOrder[0]
    ).toBeLessThan(refetch.mock.invocationCallOrder[0]);
  });
});
