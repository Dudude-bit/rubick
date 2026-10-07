import { describe, expect, it, vi } from "vite-plus/test";
import { screen } from "@testing-library/react";

import type {
  HelmChartSearchResult,
  HelmRelease,
  HelmReleaseDetail,
  HelmRepository,
  HelmRevision,
} from "@/generated/types";
import { useClusterStore } from "@/stores/clusterStore";
import { useDependenciesStore } from "@/stores/dependenciesStore";
import { renderWithRouter } from "@/test/render";

const getHelmReleaseDetail = vi.fn();
const getHelmHistory = vi.fn();
vi.mock("@/lib/commands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/commands")>()),
  commands: {
    getHelmReleaseDetail: (...args: unknown[]) => getHelmReleaseDetail(...args),
    getHelmHistory: (...args: unknown[]) => getHelmHistory(...args),
  },
}));

const { HelmChartsTab } = await import("./HelmChartsTab");
const { HelmRepositoriesTab } = await import("./HelmRepositoriesTab");
const { HelmHistoryDialog } = await import("./HelmHistoryDialog");
const { HelmDetail } = await import("./HelmDetail");

/**
 * WebKitGTK's overlay scrollbar takes the pointer over a scrolling port's last
 * 21px, and these tables' last cell ended at the port's edge, so the Install,
 * Remove and Roll back buttons hid under it. DataTable has kept 24px since
 * wave 6; fails if a hand-built table's last button goes back to the 10px of
 * an ordinary cell.
 */
const GUTTER = "24px";
const cellOf = (name: string) =>
  screen
    .getAllByRole("button", { name })
    .map((button) => button.closest("td"))
    .find((cell) => cell !== null);

const revision = (n: number): HelmRevision => ({
  revision: n,
  updated: "2026-10-01T10:00:00Z",
  status: n === 2 ? "deployed" : "superseded",
  chart: "web-1.0.0",
  appVersion: "1.0.0",
  description: null,
});

describe("the last button of a hand-built Helm table", () => {
  it("keeps Install in the chart search clear of the scrollbar", async () => {
    const chart: HelmChartSearchResult = {
      name: "nginx",
      version: "1.0.0",
      appVersion: "1.25",
      description: "A web server",
    } as HelmChartSearchResult;
    await renderWithRouter(
      <HelmChartsTab
        searchKeyword="nginx"
        onSearchKeywordChange={vi.fn()}
        results={[chart]}
        isSearching={false}
        onSearch={vi.fn()}
        onInstall={vi.fn()}
      />,
      { at: "/c/test/helm", route: "/c/$cluster/helm" }
    );
    expect(cellOf("Install")).toHaveStyle({ paddingRight: GUTTER });
  });

  it("keeps Remove in the repository list clear of the scrollbar", async () => {
    const repository = {
      name: "bitnami",
      url: "https://charts.bitnami.com/bitnami",
    } as HelmRepository;
    await renderWithRouter(
      <HelmRepositoriesTab
        repositories={[repository]}
        isLoading={false}
        isUpdating={false}
        onUpdateAll={vi.fn()}
        onAddRepoClick={vi.fn()}
        onDeleteRepo={vi.fn()}
      />,
      { at: "/c/test/helm", route: "/c/$cluster/helm" }
    );
    expect(cellOf("Remove")).toHaveStyle({ paddingRight: GUTTER });
  });

  it("keeps Roll back in the history dialog clear of the scrollbar", async () => {
    await renderWithRouter(
      <HelmHistoryDialog
        release={{ name: "web", namespace: "shop" } as HelmRelease}
        history={[revision(1), revision(2)]}
        isLoading={false}
        helmCliAvailable
        onClose={vi.fn()}
        onRollback={vi.fn()}
      />,
      { at: "/c/test/helm", route: "/c/$cluster/helm" }
    );
    expect(cellOf("Roll back")).toHaveStyle({ paddingRight: GUTTER });
  });

  it("keeps Roll back in a release's History tab clear of the scrollbar", async () => {
    useClusterStore.setState({ isConnected: true });
    useDependenciesStore.setState({
      helm: { available: true, path: "/usr/bin/helm", version: "v3" },
    } as never);
    getHelmReleaseDetail.mockResolvedValue({
      name: "web",
      namespace: "shop",
      revision: 2,
      status: "deployed",
      chart: "web",
      chartVersion: "1.0.0",
      appVersion: "1.0.0",
      firstDeployed: null,
      lastDeployed: null,
      description: null,
      values: {},
      manifest: "",
      notes: null,
    } satisfies HelmReleaseDetail);
    getHelmHistory.mockResolvedValue([revision(1), revision(2)]);
    await renderWithRouter(<HelmDetail />, {
      at: "/c/test/helm/native/shop/web?tab=history",
      route: "/c/$cluster/helm/$source/$namespace/$name",
    });
    await screen.findAllByRole("cell");
    expect(cellOf("Roll back")).toHaveStyle({ paddingRight: GUTTER });
  });
});
