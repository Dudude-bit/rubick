import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { fireEvent, screen } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";

import type { TerminalSessionInfo } from "@/generated/types";
import { renderWithRouter } from "@/test/render";
import { useClusterStore } from "@/stores/clusterStore";
import { useTerminalSessionStore } from "@/stores/terminalSessionStore";
import { useKeptShellStore } from "@/stores/keptShellStore";
import { useScopeTabStore } from "@/stores/scopeTabStore";
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
  useKeptShellStore.setState({ shells: [] });
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

  /**
   * A tab parked on another cluster keeps its shell, and the status bar
   * counts it. Fails if the list leaves out what the count includes.
   */
  it("lists a shell kept on another cluster, naming the cluster", async () => {
    useClusterStore.setState({ currentContext: "acme-staging" });
    useTerminalSessionStore.setState({
      sessions: [{ ...shell("api-0"), context: "acme-prod" }],
    });
    await renderWithRouter(<TerminalsTab />);

    expect(screen.getByRole("link", { name: /api-0/ })).toHaveTextContent(
      /acme-prod · shop · app · connected/
    );
    expect(screen.queryByText("No shells are open")).toBeNull();
  });

  /**
   * The way back to a parked shell is its own tab, on its Shell tab; the tab
   * on screen stays where it is. Fails if the row navigates the tab on
   * screen, which would end any shell that tab keeps.
   */
  it("takes the reader back to the tab that keeps the shell, on its Shell tab", async () => {
    useClusterStore.setState({ currentContext: "acme-staging" });
    useScopeTabStore.setState({
      tabs: [
        {
          id: "here",
          context: "acme-staging",
          namespace: "",
          scope: [],
          href: "/c/acme-staging/events",
          missing: false,
        },
        {
          id: "owner",
          context: "acme-staging",
          namespace: "",
          scope: [],
          href: "/c/acme-staging/pods/shop/cart-4f68h?tab=logs",
          missing: false,
        },
      ],
      activeId: "here",
      pendingHref: null,
    });
    useKeptShellStore.getState().keep({
      id: "term-cart-4f68h",
      tab: "owner",
      context: "acme-staging",
      namespace: "shop",
      pod: "cart-4f68h",
      container: "app",
    });
    useTerminalSessionStore.setState({ sessions: [shell("cart-4f68h")] });
    await renderWithRouter(<TerminalsTab />, { at: "/c/acme-staging/events" });

    fireEvent.click(
      screen.getByRole("link", { name: /shop · app · connected/ })
    );

    const tabs = useScopeTabStore.getState();
    expect(tabs.activeId).toBe("owner");
    expect(tabs.pendingHref).toBe(
      "/c/acme-staging/pods/shop/cart-4f68h?tab=shell"
    );
    expect(tabs.tabs.find((tab) => tab.id === "here")?.href).toBe(
      "/c/acme-staging/events"
    );
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
    expect(screen.queryByText("No shells are open")).toBeNull();

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
