import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/commands", () => ({
  commands: {
    connectCluster: vi.fn(async (context: string) => ({ context })),
    disconnectCluster: vi.fn(async () => undefined),
    saveClusterPreferences: vi.fn(async () => undefined),
  },
}));

import { useClusterStore } from "./clusterStore";
import {
  tabRouteLabel,
  tabTitle,
  useScopeTabStore,
  type ScopeTab,
} from "./scopeTabStore";

const tab = (over: Partial<ScopeTab> = {}): ScopeTab => ({
  id: "t1",
  context: null,
  namespace: "",
  href: "/",
  missing: false,
  ...over,
});

function seed(tabs: ScopeTab[], activeId = tabs[0].id) {
  useScopeTabStore.setState({ tabs, activeId, pendingHref: null });
}

function live(context: string | null, namespace = "") {
  useClusterStore.setState({
    currentContext: context,
    currentNamespace: namespace,
    isConnected: !!context,
  });
}

const state = () => useScopeTabStore.getState();

beforeEach(() => {
  localStorage.clear();
  live(null);
  seed([tab()]);
});

describe("a tab holds a route", () => {
  it("records every navigation onto the active tab", () => {
    seed([tab({ id: "a" }), tab({ id: "b" })], "a");
    state().recordHref("/workloads/pods?peek=pods%2Fdefault%2Fapi-1");
    expect(state().tabs[0].href).toBe(
      "/workloads/pods?peek=pods%2Fdefault%2Fapi-1"
    );
    expect(state().tabs[1].href).toBe("/");
  });

  it("ignores a navigation that belongs to the tab being left", async () => {
    seed([tab({ id: "a", href: "/events" }), tab({ id: "b", href: "/nodes" })]);
    await state().activateTab("b");
    // The router has not moved yet; the route it still reports is A's.
    state().recordHref("/events");
    expect(state().tabs[1].href).toBe("/nodes");
    expect(state().pendingHref).toBe("/nodes");
  });

  it("asks for the tab's route on activation and parks the one it leaves", async () => {
    live("prod", "web");
    seed([
      tab({ id: "a", href: "/events" }),
      tab({ id: "b", context: "prod", namespace: "api", href: "/nodes" }),
    ]);
    await state().activateTab("b");
    expect(state().activeId).toBe("b");
    expect(state().pendingHref).toBe("/nodes");
    expect(state().tabs[0]).toMatchObject({
      context: "prod",
      namespace: "web",
    });
    expect(useClusterStore.getState().currentNamespace).toBe("api");
  });

  it("clears the pending route once the router has landed", async () => {
    seed([tab({ id: "a" }), tab({ id: "b", href: "/nodes" })]);
    await state().activateTab("b");
    state().routeSettled();
    expect(state().pendingHref).toBeNull();
    state().recordHref("/nodes/agent-0");
    expect(state().tabs[1].href).toBe("/nodes/agent-0");
  });
});

describe("opening", () => {
  it("opens on the overview of the cluster already on screen", async () => {
    live("prod", "web");
    await state().openTab();
    expect(state().tabs).toHaveLength(2);
    expect(state().tabs[1]).toMatchObject({
      context: "prod",
      namespace: "web",
      href: "/",
    });
    expect(state().activeId).toBe(state().tabs[1].id);
  });

  it("keeps a background tab behind the one being read", async () => {
    live("prod");
    seed([tab({ id: "a", href: "/events" })]);
    await state().openTab({ href: "/pods/web/api-1", background: true });
    expect(state().activeId).toBe("a");
    expect(state().pendingHref).toBeNull();
    expect(state().tabs[1].href).toBe("/pods/web/api-1");
  });

  it("hands every tab its own id after a restore reused the counter", async () => {
    seed([tab({ id: "scope-7" })]);
    await state().openTab();
    await state().openTab();
    const ids = state().tabs.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("closing", () => {
  it("activates the tab that slid into its place", async () => {
    seed(
      [
        tab({ id: "a", href: "/a" }),
        tab({ id: "b", href: "/b" }),
        tab({ id: "c", href: "/c" }),
      ],
      "b"
    );
    await state().closeTab("b");
    expect(state().activeId).toBe("c");
    expect(state().pendingHref).toBe("/c");
  });

  it("falls back to the new last tab when the rightmost closes", async () => {
    seed([tab({ id: "a", href: "/a" }), tab({ id: "b", href: "/b" })], "b");
    await state().closeTab("b");
    expect(state().activeId).toBe("a");
    expect(state().pendingHref).toBe("/a");
  });

  it("leaves a parked tab closed without moving the reader", async () => {
    seed([tab({ id: "a", href: "/a" }), tab({ id: "b", href: "/b" })], "a");
    await state().closeTab("b");
    expect(state().tabs).toHaveLength(1);
    expect(state().activeId).toBe("a");
    expect(state().pendingHref).toBeNull();
  });

  // Zero tabs is a window with no scope and no chrome to pick one in.
  it("resets the last tab instead of emptying the strip", async () => {
    live("prod", "web");
    seed([tab({ id: "a", context: "prod", namespace: "web", href: "/nodes" })]);
    await state().closeTab("a");
    expect(state().tabs).toHaveLength(1);
    expect(state().tabs[0]).toMatchObject({
      context: null,
      namespace: "",
      href: "/",
    });
    expect(state().pendingHref).toBe("/");
    expect(useClusterStore.getState().currentContext).toBeNull();
  });
});

describe("stepping", () => {
  beforeEach(() =>
    seed([tab({ id: "a" }), tab({ id: "b" }), tab({ id: "c" })], "a")
  );

  it("wraps at both ends", async () => {
    await state().activateRelative(-1);
    expect(state().activeId).toBe("c");
    await state().activateRelative(1);
    expect(state().activeId).toBe("a");
  });

  it("takes the ninth shortcut to the last tab however many there are", async () => {
    await state().activateIndex(-1);
    expect(state().activeId).toBe("c");
  });

  it("ignores a position no tab occupies", async () => {
    await state().activateIndex(7);
    expect(state().activeId).toBe("a");
  });
});

describe("a cluster the kubeconfig has lost", () => {
  it("flags the tab rather than deleting the workspace", () => {
    seed([
      tab({ id: "a", context: "gone" }),
      tab({ id: "b", context: "prod" }),
    ]);
    state().reconcileContexts(["prod"]);
    expect(state().tabs[0].missing).toBe(true);
    expect(state().tabs[1].missing).toBe(false);
  });

  // An empty list is a kubeconfig that failed to load, not one with no clusters.
  it("says nothing while the kubeconfig is unread", () => {
    seed([tab({ id: "a", context: "prod" })]);
    state().reconcileContexts([]);
    expect(state().tabs[0].missing).toBe(false);
  });

  it("drops the connection rather than show another cluster under its name", async () => {
    live("prod");
    seed([
      tab({ id: "a", context: "prod" }),
      tab({ id: "b", context: "gone" }),
    ]);
    state().reconcileContexts(["prod"]);
    await state().activateTab("b");
    expect(useClusterStore.getState().isConnected).toBe(false);
    expect(useClusterStore.getState().currentContext).toBeNull();
  });

  it("keeps the name it was pointed at when it is the active tab", async () => {
    live("prod");
    seed([
      tab({ id: "a", context: "prod" }),
      tab({ id: "b", context: "gone" }),
    ]);
    state().reconcileContexts(["prod"]);
    await state().activateTab("b");
    await state().activateTab("a");
    expect(state().tabs[1].context).toBe("gone");
  });

  it("clears the flag once the tab is pointed somewhere real", () => {
    seed([tab({ id: "a", context: "gone", missing: true })]);
    state().reconcileContexts(["gone", "prod"]);
    expect(state().tabs[0].missing).toBe(false);
  });
});

describe("titles", () => {
  it.each([
    ["/", "overview"],
    ["/workloads/pods", "pods"],
    ["/nodes", "nodes"],
    ["/events", "events"],
    ["/settings", "settings"],
    ["/helm", "helm"],
    ["/pods/web/api-7f9", "api-7f9"],
    ["/nodes/k3d-agent-0", "k3d-agent-0"],
  ])("names %s as %s", (href, expected) => {
    expect(tabRouteLabel(href)).toBe(expected);
  });

  // The peek is the foreground, so it is what the tab is showing.
  it("names the open peek over the list behind it", () => {
    expect(tabRouteLabel("/workloads/pods?peek=pods%2Fweb%2Fapi-7f9")).toBe(
      "api-7f9"
    );
  });

  it("never falls back to a raw pathname", () => {
    expect(tabRouteLabel("/some/unknown/place")).toBe("place");
  });

  it("spells the whole tab for a tooltip", () => {
    expect(
      tabTitle(tab({ context: "prod", namespace: "web", href: "/nodes" }))
    ).toBe("prod · web · nodes");
    expect(tabTitle(tab({ href: "/" }))).toBe(
      "no cluster · all namespaces · overview"
    );
    expect(tabTitle(tab({ context: "old", missing: true }))).toBe(
      "old (missing) · all namespaces · overview"
    );
  });
});

describe("surviving a restart", () => {
  const migrate = (persisted: unknown, version: number) => {
    const fn = useScopeTabStore.persist.getOptions().migrate;
    if (!fn) throw new Error("no migrate configured");
    return fn(persisted, version) as { tabs: ScopeTab[] };
  };

  it("lands a routeless tab on the overview instead of discarding it", () => {
    const migrated = migrate(
      { tabs: [{ id: "a", context: "prod", namespace: "web" }], activeId: "a" },
      0
    );
    expect(migrated.tabs[0]).toMatchObject({
      context: "prod",
      namespace: "web",
      href: "/",
    });
  });

  it("throws away a payload that is not a tab", () => {
    expect(migrate({ tabs: [null, { context: "prod" }] }, 0).tabs).toEqual([]);
  });

  it("brings the tabs back and asks the router for the active route", async () => {
    localStorage.setItem(
      "scope-tabs",
      JSON.stringify({
        state: {
          tabs: [
            {
              id: "scope-1",
              context: "prod",
              namespace: "",
              href: "/events",
              missing: false,
            },
            {
              id: "scope-2",
              context: "prod",
              namespace: "web",
              href: "/workloads/pods",
              missing: false,
            },
          ],
          activeId: "scope-2",
        },
        version: 1,
      })
    );
    await useScopeTabStore.persist.rehydrate();
    expect(state().tabs).toHaveLength(2);
    expect(state().activeId).toBe("scope-2");
    // The window boots at "/", so the restored route has to be asked for.
    expect(state().pendingHref).toBe("/workloads/pods");
  });

  it("recovers from an active id that no tab carries", async () => {
    localStorage.setItem(
      "scope-tabs",
      JSON.stringify({
        state: {
          tabs: [
            {
              id: "scope-1",
              context: null,
              namespace: "",
              href: "/nodes",
              missing: false,
            },
          ],
          activeId: "scope-99",
        },
        version: 1,
      })
    );
    await useScopeTabStore.persist.rehydrate();
    expect(state().activeId).toBe("scope-1");
    expect(state().pendingHref).toBe("/nodes");
  });
});
