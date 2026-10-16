import { screen } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { HelmReleaseDetail } from "@/generated/types";
import { useClusterStore } from "@/stores/clusterStore";
import { renderWithRouter } from "@/test/render";
import { HelmDetail } from "./HelmDetail";

const web: HelmReleaseDetail = {
  name: "web",
  namespace: "team-a",
  revision: 3,
  status: "deployed",
  chart: "nginx",
  chartVersion: "1.0.0",
  appVersion: "1.0.0",
  firstDeployed: "2026-09-01T10:00:00Z",
  lastDeployed: "2026-09-05T10:00:00Z",
  description: null,
  values: {},
  manifest: "",
  notes: null,
};

/** How the cluster answers for the release's history, per test. */
const history = vi.hoisted(() => ({
  answer: (): Promise<unknown> => Promise.resolve([]),
}));

beforeEach(() => {
  useClusterStore.setState({ isConnected: true, currentContext: "prod" });
  vi.mocked(invoke).mockImplementation(async (command: string) => {
    if (command === "get_helm_release_detail") return web;
    if (command === "get_helm_history") return history.answer();
    if (command.startsWith("list_")) return [];
    return undefined;
  });
});

const open = () =>
  renderWithRouter(<HelmDetail />, {
    at: "/c/prod/helm/native/team-a/web?tab=history",
    route: "/c/$cluster/helm/$source/$namespace/$name",
  });

describe("a Helm release's History tab", () => {
  /**
   * A history read that failed read "History 0" over "No history: Helm
   * keeps none for this release". Fails if the tab or its body states none
   * for a history nobody could read.
   */
  it("says the history could not be read, on the tab and in it", async () => {
    history.answer = () =>
      Promise.reject({ code: "PERMISSION_DENIED", message: "forbidden" });
    await open();

    expect(
      await screen.findByText("Could not read this release's history.")
    ).toBeInTheDocument();
    expect(screen.queryByText(/No history/)).toBeNull();
    expect(
      screen.getByRole("tab", { name: /History/ }).textContent
    ).not.toMatch(/\d/);
  });

  /** Fails if a history still on its way is counted as none. */
  it("wears no number while the history is still being read", async () => {
    history.answer = () => new Promise(() => {});
    await open();

    expect(
      await screen.findByRole("tab", { name: /History/ })
    ).not.toHaveTextContent(/\d/);
  });
});
