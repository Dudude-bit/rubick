import type { ReactNode } from "react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { renderWithRouter, testQueryClient } from "@/test/render";
import { TooltipProvider } from "@/components/ui/tooltip";
import { appSearch } from "@/lib/app-search";
import { setRouter } from "@/lib/links";
import {
  scrollbackOf,
  useKeptShellStore,
  type KeptShell,
} from "@/stores/keptShellStore";
import { useClusterStore } from "@/stores/clusterStore";
import { useScopeTabStore } from "@/stores/scopeTabStore";
import { useTerminalSessionStore } from "@/stores/terminalSessionStore";
import { useScopeTabs } from "@/routes/c/$cluster/-shell/useScopeTabs";
import { TerminalsTab } from "@/routes/c/$cluster/-shell/activity/TerminalsTab";
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
  useTerminalSessionStore.setState({ sessions: null, failed: null });
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

const POD = "/c/acme-staging/pods/shop/cart-4f68h";
const OVERVIEW = "/c/acme-staging";

/** A route chunk or loader still on its way, as a real route is on a tab switch. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

function Bridge() {
  useScopeTabs();
  return null;
}

/**
 * The window as it runs: the scope tab bridge mounted once above the pages,
 * the pod page slow to load, and the shells kept by `keepShells`.
 */
async function windowAt(
  at: string,
  {
    pod,
    events,
    overview = <p>overview</p>,
  }: {
    pod: Promise<void>;
    events?: Promise<void>;
    overview?: ReactNode;
  }
) {
  const root = createRootRoute({
    component: () => (
      <>
        <Bridge />
        <Outlet />
      </>
    ),
  });
  const page = (path: string, ui: ReactNode, loading?: Promise<void>) =>
    createRoute({
      getParentRoute: () => root,
      path,
      validateSearch: appSearch,
      loader: loading ? () => loading : undefined,
      component: () => ui,
    });
  const router = createRouter({
    routeTree: root.addChildren([
      page("/c/$cluster", overview),
      page("/c/$cluster/pods/$namespace/$name", <p>pod page</p>, pod),
      page("/c/$cluster/events", <p>events page</p>, events),
    ]),
    history: createMemoryHistory({ initialEntries: [at] }),
    defaultPendingMinMs: 0,
  });
  setRouter(router);
  await act(() => router.load());
  render(
    <QueryClientProvider client={testQueryClient()}>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
    </QueryClientProvider>
  );
  stop = keepShells(router, onLeftPage);
  return router;
}

const parked = (id: string, href: string) => ({
  id,
  context: "acme-staging",
  namespace: "",
  scope: [],
  href,
  missing: false,
});

const onLeftPage = vi.fn();
const tabs = () => useScopeTabStore.getState();
const kept = () => useKeptShellStore.getState().shells;

describe("a shell whose tab comes back", () => {
  beforeEach(() => {
    onLeftPage.mockClear();
    vi.mocked(invoke).mockClear();
    useClusterStore.setState({
      currentContext: "acme-staging",
      currentNamespace: "",
      namespaceScope: [],
    });
    useScopeTabStore.setState({
      tabs: [parked("tab-1", `${POD}?tab=shell`), parked("tab-2", OVERVIEW)],
      activeId: "tab-2",
      pendingHref: null,
    });
  });

  /**
   * Dana and Lena clicked back to the tab that kept their shell and it ended
   * at once, "because its tab moved to another page". The bridge settles the
   * tab when the router starts for the pod page, before that page has loaded,
   * and the shell was judged by the page the window was still leaving. Fails
   * if the shell is ended at any point of the switch back.
   */
  it("keeps the shell through every step of clicking back to its tab", async () => {
    const pod = gate();
    const router = await windowAt(OVERVIEW, { pod: pod.opened });
    act(() => useKeptShellStore.getState().keep(KEPT));

    await act(() => tabs().activateTab("tab-1"));
    await vi.waitFor(() => expect(tabs().pendingHref).toBeNull());
    expect(router.state.status).toBe("pending");
    expect(router.state.resolvedLocation?.pathname).toBe(OVERVIEW);
    expect(kept()).toEqual([KEPT]);

    await act(async () => pod.open());
    await vi.waitFor(() =>
      expect(router.state.resolvedLocation?.pathname).toBe(POD)
    );
    expect(kept()).toEqual([KEPT]);
    expect(onLeftPage).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalledWith("close_terminal", {
      sessionId: KEPT.id,
    });
  });

  /**
   * Activity's row takes the reader to the tab that keeps the shell, on its
   * Shell tab, by the same switch. Fails if the shell dies on arrival, or if
   * Activity stays open over the page it went to.
   */
  it("keeps the shell when Activity's row takes the reader back to its tab", async () => {
    const pod = gate();
    const closeActivity = vi.fn();
    const other = { ...KEPT, id: "term-2", pod: "cart-9x2kq" };
    const page = "/c/acme-staging/pods/shop/cart-9x2kq";
    useTerminalSessionStore.setState({
      sessions: [
        {
          id: other.id,
          context: other.context,
          namespace: other.namespace,
          pod: other.pod,
          container: other.container,
          state: "connected",
          openedAt: "2026-10-09T09:00:00Z",
        },
      ],
    });
    useScopeTabStore.setState({
      tabs: [parked("tab-1", `${page}?tab=logs`), parked("tab-2", OVERVIEW)],
    });
    const router = await windowAt(OVERVIEW, {
      pod: pod.opened,
      overview: <TerminalsTab onClose={closeActivity} />,
    });
    act(() => useKeptShellStore.getState().keep(other));

    fireEvent.click(screen.getByText(/shop · app · connected/));
    expect(closeActivity).toHaveBeenCalled();
    await vi.waitFor(() => expect(tabs().pendingHref).toBeNull());
    expect(router.state.status).toBe("pending");
    expect(kept()).toEqual([other]);

    await act(async () => pod.open());
    await vi.waitFor(() =>
      expect(router.state.resolvedLocation?.href).toBe(`${page}?tab=shell`)
    );
    expect(tabs().activeId).toBe("tab-1");
    expect(kept()).toEqual([other]);
    expect(onLeftPage).not.toHaveBeenCalled();
  });

  /**
   * The other half of the rule: a tab that has landed on its pod and then
   * goes to another page in place ends the shell, and says so, once it has
   * arrived there and not while it is on its way. Fails if leaving keeps the
   * shell, or if a navigation still loading is taken for one that landed.
   */
  it("ends the shell once its tab has landed on another page, not while on its way", async () => {
    const events = gate();
    useScopeTabStore.setState({ activeId: "tab-1" });
    const router = await windowAt(`${POD}?tab=shell`, {
      pod: Promise.resolve(),
      events: events.opened,
    });
    act(() => useKeptShellStore.getState().keep(KEPT));
    expect(kept()).toEqual([KEPT]);

    act(() => void router.navigate({ href: "/c/acme-staging/events" }));
    await vi.waitFor(() =>
      expect(router.state.location.pathname).toBe("/c/acme-staging/events")
    );
    expect(router.state.status).toBe("pending");
    expect(kept()).toEqual([KEPT]);

    await act(async () => events.open());
    await vi.waitFor(() => expect(kept()).toEqual([]));
    expect(onLeftPage).toHaveBeenCalledWith(KEPT);
    expect(invoke).toHaveBeenCalledWith("close_terminal", {
      sessionId: KEPT.id,
    });
  });
});
