import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { act, screen, waitFor } from "@testing-library/react";

vi.mock("@/lib/commands", () => ({
  commands: {
    listHelmReleasesIn: vi.fn(),
    listNamespaces: vi.fn(async () => []),
    listHelmRepos: vi.fn(async () => []),
    getHelmHistory: vi.fn(async () => []),
    checkHelmAvailability: vi.fn(async () => ({
      available: false,
      version: null,
      path: null,
      error: null,
      searchedPaths: [],
    })),
  },
}));

import { commands } from "@/lib/commands";
import type { HelmRelease } from "@/generated/types";
import { useClusterStore } from "@/stores/clusterStore";
import { renderWithRouter } from "@/test/render";
import { Helm } from "./Helm";

const release = (name: string): HelmRelease => ({
  name,
  namespace: "team-a",
  revision: 1,
  status: "deployed",
  chart: "nginx-1.0.0",
  appVersion: "1.0.0",
  updated: "2026-09-05T10:00:00Z",
  source: "native",
  suspended: false,
  sourceRef: null,
  unreadable: null,
});

const listReleases = vi.mocked(commands.listHelmReleasesIn);

beforeEach(() => {
  listReleases.mockReset();
  useClusterStore.setState({ isConnected: true, namespaceScope: [] });
});

describe("Helm releases whose re-read fails", () => {
  /**
   * During the 502 outage the lists kept their rows and said since when,
   * while Helm kept its releases with nothing saying the reads had stopped
   * answering: no freshness reached the page at all. Fails if the releases
   * are dropped for the error, or kept with nothing saying they are old.
   */
  it("keeps the releases, says they are from the last read that answered, and its header says the read is failing", async () => {
    listReleases.mockResolvedValueOnce({
      rows: [release("web"), release("api")],
      unread: [],
    });
    const { client } = await renderWithRouter(<Helm />, {
      at: "/c/prod/helm",
      route: "/c/$cluster/helm",
    });
    await screen.findByText("web");
    expect(screen.getByText("polling")).toBeInTheDocument();

    listReleases.mockRejectedValue(new Error("502 Bad Gateway"));
    await act(() => client.refetchQueries());

    expect(
      await screen.findByText(/Could not read Helm releases just now/)
    ).toBeInTheDocument();
    expect(screen.getByText("web")).toBeInTheDocument();
    expect(screen.getByText("api")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText("read failing")).toBeInTheDocument()
    );
    expect(screen.queryByText("polling")).toBeNull();
  });
});
