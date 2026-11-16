import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { renderWithProviders } from "@/test/render";
import { useActivityPanelStore } from "@/stores/activityPanelStore";
import { useClusterStore } from "@/stores/clusterStore";
import { recordWriteFailure, useWriteLog } from "@/stores/writeLogStore";
import { ActivityPanel } from "./ActivityPanel";

afterEach(() => {
  useWriteLog.setState({ records: [] });
  useActivityPanelStore.setState({ open: false, tab: "ports", unseen: null });
});

describe("the Activity trigger", () => {
  /**
   * The panel opened on Ports right after a failed write, one tab away from
   * the entry the reader came for. Fails if the trigger opens on any tab but
   * the one with the newest unseen entry.
   */
  it("opens on Writes right after a write failed", async () => {
    useClusterStore.setState({ currentContext: "gke" });
    recordWriteFailure("Restart pod x?", new Error("boom"));
    await renderWithProviders(<ActivityPanel />);
    await userEvent.click(screen.getByRole("button", { name: /activity/i }));
    expect(
      await screen.findByRole("tab", { name: /Writes/, selected: true })
    ).toBeInTheDocument();
    expect(screen.getByText("Restart pod x")).toBeInTheDocument();
  });
});
