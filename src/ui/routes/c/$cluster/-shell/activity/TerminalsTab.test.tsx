import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { fireEvent, screen } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";

import type { TerminalSessionInfo } from "@/generated/types";
import { renderWithRouter } from "@/test/render";
import { useClusterStore } from "@/stores/clusterStore";
import { useTerminalSessionStore } from "@/stores/terminalSessionStore";
import { ActivityPanel } from "../ActivityPanel";
import { TerminalsTab } from "./TerminalsTab";

const shell = (
  pod: string,
  state: TerminalSessionInfo["state"] = "connected"
): TerminalSessionInfo => ({
  id: `term-${pod}`,
  context: "acme-staging",
  namespace: "shop",
  pod,
  container: "app",
  state,
  openedAt: "2026-10-09T09:00:00Z",
});

afterEach(() => {
  useTerminalSessionStore.setState({ sessions: null, failed: null });
  useClusterStore.setState({ currentContext: null });
  vi.mocked(invoke).mockImplementation(async () => undefined);
});

describe("Activity's terminals", () => {
  /**
   * Dana left the pages of two shells; Activity said none were open while
   * both still ran. Fails if a shell the backend holds without a pane is
   * missing here.
   */
  it("lists every shell the backend holds, with or without a page", async () => {
    useClusterStore.setState({ currentContext: "acme-staging" });
    useTerminalSessionStore.setState({
      sessions: [shell("cart-4f68h"), shell("search-ztqf7", "closing")],
    });
    await renderWithRouter(<TerminalsTab />);

    const rows = screen.getAllByRole("link", { name: /app ·/ });
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringMatching(/cart-4f68h.*shop · app · connected/),
      expect.stringMatching(/search-ztqf7.*shop · app · closing/),
    ]);
  });

  /** A shell with no page left needs ending from here. */
  it("ends a shell from its row", async () => {
    useClusterStore.setState({ currentContext: "acme-staging" });
    useTerminalSessionStore.setState({ sessions: [shell("cart-4f68h")] });
    await renderWithRouter(<TerminalsTab />);

    fireEvent.click(
      screen.getByRole("button", { name: "End the shell in cart-4f68h" })
    );

    expect(invoke).toHaveBeenCalledWith("close_terminal", {
      sessionId: "term-cart-4f68h",
    });
  });

  /** Fails if a list not read yet, or refused, reads as "no terminals". */
  it("tells an unread list from an empty one", async () => {
    useClusterStore.setState({ currentContext: "acme-staging" });
    await renderWithRouter(<TerminalsTab />);
    expect(screen.getByText("Reading the open terminals")).toBeInTheDocument();
    expect(screen.queryByText(/No terminal sessions/)).toBeNull();

    useTerminalSessionStore.setState({ failed: "the bridge is down" });
    expect(
      await screen.findByText("Could not read the open terminals")
    ).toBeInTheDocument();
    expect(screen.getByText("the bridge is down")).toBeInTheDocument();
  });

  /**
   * The status bar counted only "connected", so a shell still hanging up
   * was not counted though it still ran. Fails if any live one is left out.
   */
  it("counts every shell the backend holds in the status bar", async () => {
    useTerminalSessionStore.setState({
      sessions: [
        shell("cart-4f68h", "connecting"),
        shell("search-ztqf7", "closing"),
      ],
    });
    await renderWithRouter(<ActivityPanel />);

    expect(
      screen.getByRole("button", { name: "Activity panel" })
    ).toHaveTextContent("2 terminals");
  });
});
