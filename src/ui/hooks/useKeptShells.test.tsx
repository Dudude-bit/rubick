import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { listen } from "@tauri-apps/api/event";

import { renderWithRouter } from "@/test/render";
import {
  scrollbackOf,
  useKeptShellStore,
  type KeptShell,
} from "@/stores/keptShellStore";
import { useScopeTabStore } from "@/stores/scopeTabStore";
import { keepShells } from "./useKeptShells";

const handlers: Record<string, (event: { payload: unknown }) => void> = {};
const send = (channel: string, payload: unknown) =>
  handlers[channel]?.({ payload });

const KEPT: KeptShell = {
  id: "term-1",
  tab: "tab-1",
  context: "acme-staging",
  namespace: "shop",
  pod: "cart-4f68h",
  container: "app",
};

let stop: (() => void) | null = null;

beforeEach(() => {
  vi.mocked(listen).mockImplementation(async (channel, handler) => {
    handlers[channel] = handler as (event: { payload: unknown }) => void;
    return () => {};
  });
  useKeptShellStore.setState({ shells: [] });
  useScopeTabStore.setState({
    tabs: [
      {
        id: "tab-1",
        context: "acme-staging",
        namespace: "",
        scope: [],
        href: "/c/acme-staging/pods/shop/cart-4f68h",
        missing: false,
      },
    ],
    activeId: "tab-1",
    pendingHref: null,
  });
});

afterEach(() => {
  stop?.();
  stop = null;
  vi.mocked(listen).mockImplementation(async () => () => {});
});

/**
 * Nobody watches a parked shell, so the window does, for the pane that comes
 * back. Fails if what it printed meanwhile is lost, or if one that ended is
 * still kept and would be attached to.
 */
it("holds what a kept shell prints while no pane shows it, and lets go when it ends", async () => {
  const { router } = await renderWithRouter(<p>pod page</p>, {
    at: "/c/acme-staging/pods/shop/cart-4f68h",
  });
  stop = keepShells(router, () => {});
  await vi.waitFor(() => expect(handlers["terminal-closed"]).toBeDefined());
  useKeptShellStore.getState().keep(KEPT);

  send("terminal-output", { session_id: "term-1", data: "/srv/app # " });
  send("terminal-output", { session_id: "term-2", data: "not kept" });
  expect(scrollbackOf("term-1")).toBe("/srv/app # ");

  send("terminal-closed", { session_id: "term-1", status: null });
  expect(useKeptShellStore.getState().shells).toEqual([]);
  expect(scrollbackOf("term-1")).toBe("");
});
