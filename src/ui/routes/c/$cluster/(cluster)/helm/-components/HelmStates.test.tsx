import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vite-plus/test";

import type { HelmChartSearchResult } from "@/generated/types";
import { renderWithRouter } from "@/test/render";
import { HelmChartsTab } from "./HelmChartsTab";
import { HelmReleasesTab } from "./HelmReleasesTab";
import { HelmRepositoriesTab } from "./HelmRepositoriesTab";

const repositoriesProps = {
  isLoading: false,
  isUpdating: false,
  onUpdateAll: () => {},
  onAddRepoClick: () => {},
  onDeleteRepo: () => {},
};

const chartsProps = {
  searchKeyword: "nginx",
  onSearchKeywordChange: () => {},
  isSearching: false,
  onSearch: () => {},
  onInstall: () => {},
};

describe("the repositories tab when the list could not be read", () => {
  /** A failed list-repos read drawn as "No repositories configured" is the collapse of could-not-look into none. */
  it("says it could not read them, never that none are configured", () => {
    render(
      <HelmRepositoriesTab
        {...repositoriesProps}
        repositories={undefined}
        error="helm: exec failed"
        onRetry={() => {}}
      />
    );
    expect(
      screen.getByText("Could not read the configured repositories.")
    ).toBeInTheDocument();
    expect(screen.getByText(/exec failed/)).toBeInTheDocument();
    expect(
      screen.queryByText(/no repositories configured/i)
    ).not.toBeInTheDocument();
  });

  /** The empty sentence still appears for a read that answered with nothing. */
  it("says none are configured when the read answered with none", () => {
    render(<HelmRepositoriesTab {...repositoriesProps} repositories={[]} />);
    expect(screen.getByText(/no repositories configured/i)).toBeInTheDocument();
  });
});

describe("the chart search states", () => {
  /** A search that failed must not read as the pre-search prompt or as "no chart matches". */
  it("says the search failed, with a way to try again", () => {
    render(
      <HelmChartsTab
        {...chartsProps}
        search={{
          keyword: "nginx",
          results: null,
          error: "helm search failed",
        }}
      />
    );
    expect(
      screen.getByText(/Could not search the repositories/)
    ).toBeInTheDocument();
    expect(screen.queryByText(/No chart matches/)).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Add a repository, then search/)
    ).not.toBeInTheDocument();
  });

  /** An answered search with no hit names what was searched, not the idle prompt. */
  it("names the keyword that matched nothing", () => {
    render(
      <HelmChartsTab
        {...chartsProps}
        search={{ keyword: "nginx", results: [], error: null }}
      />
    );
    expect(screen.getByText("No chart matches “nginx”.")).toBeInTheDocument();
  });

  /** Before any search the pane keeps its first prompt. */
  it("shows the prompt before any search", () => {
    render(<HelmChartsTab {...chartsProps} search={null} />);
    expect(
      screen.getByText(/Add a repository, then search/)
    ).toBeInTheDocument();
  });

  /** A search under way must not leave the previous results or the prompt on screen. */
  it("says it is searching while one runs", () => {
    const stale: HelmChartSearchResult = {
      name: "old/chart",
      version: "1",
      appVersion: "1",
      description: "",
    } as HelmChartSearchResult;
    render(
      <HelmChartsTab
        {...chartsProps}
        isSearching
        search={{ keyword: "x", results: [stale], error: null }}
      />
    );
    expect(screen.getByText("Searching the repositories…")).toBeInTheDocument();
    expect(screen.queryByText("old/chart")).not.toBeInTheDocument();
  });
});

describe("the release row menu before the helm CLI check answers", () => {
  /** "Not checked yet" worded as "CLI required" claims the CLI is missing. */
  it("says it is still checking rather than that the CLI is required", async () => {
    const user = userEvent.setup();
    await renderWithRouter(
      <HelmReleasesTab
        releases={[
          {
            name: "web",
            namespace: "team-a",
            revision: 2,
            status: "deployed",
            chart: "nginx-1.0.0",
            appVersion: "1",
            updated: "2026-09-05T10:00:00Z",
            source: "native",
            suspended: false,
            sourceRef: null,
            unreadable: null,
          },
        ]}
        isLoading={false}
        error={null}
        helmCliAvailable={false}
        helmCliChecking
        onRefetch={vi.fn()}
        onShowHistory={vi.fn()}
        onUpgrade={vi.fn()}
        onRollback={vi.fn()}
        onUninstall={vi.fn()}
      />,
      { at: "/c/test/helm", route: "/c/$cluster/helm" }
    );
    await user.click(await screen.findByRole("button", { name: /actions/i }));
    await user.hover(await screen.findByRole("menuitem", { name: /upgrade/i }));
    expect(
      (await screen.findAllByText("Checking for the helm CLI…")).length
    ).toBeGreaterThan(0);
    expect(screen.queryByText(/CLI required/i)).not.toBeInTheDocument();
  });
});
