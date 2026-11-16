import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { screen } from "@testing-library/react";

import { renderWithRouter } from "@/test/render";

const summary = vi.fn();
vi.mock("@/hooks/useClusterSummary", () => ({
  useClusterSummary: () => summary(),
}));

const { default: LokiPage } = await import("./page");
const { useClusterStore } = await import("@/stores/clusterStore");

const page = () =>
  renderWithRouter(<LokiPage />, {
    at: "/c/test/integrations/loki",
    route: "/c/$cluster/integrations/$vendor",
  });

beforeEach(() => {
  useClusterStore.setState({
    isConnected: true,
    currentContext: "test",
    namespaceScope: [],
  });
});

describe("the Loki coverage page before it knows which namespaces to ask about", () => {
  const NONE_SENTENCE = /namespaces could not be read/;

  /**
   * While the namespace list was loading, the page said the cluster has no
   * namespaces to compare. Fails if a list still on its way is drawn as an
   * empty one.
   */
  it("says it is reading the namespaces while the list is still loading", async () => {
    summary.mockReturnValue({
      namespaces: [],
      namespaceList: "pending",
      isLoading: true,
    });
    await page();
    expect(
      await screen.findByText(/Reading the cluster's namespaces/)
    ).toBeVisible();
    expect(screen.queryByText(NONE_SENTENCE)).toBeNull();
  });

  /**
   * A refused or failed namespace list is a read nobody got, not an empty
   * cluster. Fails if the "no namespaces" sentence is drawn for it.
   */
  it("says the list could not be read when it failed, not that there are none", async () => {
    summary.mockReturnValue({
      namespaces: [],
      namespaceList: "failed",
      isLoading: false,
    });
    await page();
    expect(
      await screen.findByText(/Could not read the namespace list/)
    ).toBeVisible();
    expect(screen.queryByText(NONE_SENTENCE)).toBeNull();
  });
});
