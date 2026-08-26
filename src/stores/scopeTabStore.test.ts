import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/commands", () => ({
  commands: {
    connectCluster: vi.fn(async (context: string) => ({ context })),
    disconnectCluster: vi.fn(async () => undefined),
    saveClusterPreferences: vi.fn(async () => undefined),
  },
}));

import { SCOPE_LIMIT } from "@/lib/namespace-scope";
import { useClusterStore } from "./clusterStore";
import {
  tabRouteLabel,
  tabScope,
  tabTitle,
  useScopeTabStore,
  type ScopeTab,
} from "./scopeTabStore";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";

/** The English catalogue — what these expectations are written in. */
const t: T = (section, key, values) => translate("en", section, key, values);

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
    namespaceScope: namespace === "" ? [] : [namespace],
    isConnected: !!context,
  });
}

function liveScope(context: string, scope: string[]) {
  useClusterStore.setState({
    currentContext: context,
    currentNamespace: scope.length === 1 ? scope[0] : "",
    namespaceScope: scope,
    isConnected: true,
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
      tabTitle(tab({ context: "prod", namespace: "web", href: "/nodes" }), t)
    ).toBe("prod · web · nodes");
    expect(tabTitle(tab({ href: "/" }), t)).toBe(
      "no cluster · all namespaces · overview"
    );
    expect(tabTitle(tab({ context: "old", missing: true }), t)).toBe(
      "old (missing) · all namespaces · overview"
    );
  });
});

describe("a tab parked on several namespaces", () => {
  it("carries the whole selection, and applies it on the way back", async () => {
    liveScope("prod", ["web", "api"]);
    seed([
      tab({ id: "a", context: "prod" }),
      tab({ id: "b", context: "prod" }),
    ]);
    await state().activateTab("b");
    expect(state().tabs[0].scope).toEqual(["web", "api"]);

    await state().activateTab("a");
    expect(useClusterStore.getState().namespaceScope).toEqual(["web", "api"]);
  });

  /**
   * Would break every screen of a build without this feature. A tab's
   * `namespace` is read straight into `currentNamespace` there, so a joined
   * list parked in it would ask for a namespace that does not exist — the
   * selection rides in `scope`, which that build does not read.
   */
  it("parks a namespace an older build can still ask for", async () => {
    liveScope("prod", ["web", "api"]);
    seed([
      tab({ id: "a", context: "prod" }),
      tab({ id: "b", context: "prod" }),
    ]);
    await state().activateTab("b");
    // Several has no namespace to name, and "all namespaces" is the one
    // value that shows a superset rather than nothing at all.
    expect(state().tabs[0]).toMatchObject({
      namespace: "",
      scope: ["web", "api"],
    });

    seed([
      tab({ id: "c", context: "prod" }),
      tab({ id: "d", context: "prod" }),
    ]);
    liveScope("prod", ["web"]);
    await state().activateTab("d");
    expect(state().tabs[0].namespace).toBe("web");
  });

  /**
   * Would throw away the reader's last choice on a downgrade and back. The
   * older build shows "All namespaces", writes where the reader went into
   * `namespace`, and cannot touch `scope` — so a tab that comes back up with
   * the two disagreeing is one that build moved, and reading `scope` anyway
   * would restore a selection the reader had already left.
   */
  it("prefers the namespace a build without this feature parked over it", () => {
    expect(
      tabScope(tab({ namespace: "kube-system", scope: ["prod", "staging"] }))
    ).toEqual(["kube-system"]);
    // ...and "all namespaces" is a choice like any other.
    expect(tabScope(tab({ namespace: "", scope: ["prod"] }))).toEqual([]);
    // A pair this build wrote agrees, at every size of selection, and is
    // taken as it stands.
    expect(
      tabScope(tab({ namespace: "", scope: ["prod", "staging"] }))
    ).toEqual(["prod", "staging"]);
    expect(tabScope(tab({ namespace: "prod", scope: ["prod"] }))).toEqual([
      "prod",
    ]);
    expect(tabScope(tab({ namespace: "", scope: [] }))).toEqual([]);
  });

  it("opens a new tab on the selection the reader is already reading under", async () => {
    liveScope("prod", ["web", "api"]);
    await state().openTab();
    expect(tabScope(state().tabs[1])).toEqual(["web", "api"]);
    // ...and one opened *at* an object lands on that object's namespace.
    await state().openTab({ href: "/pods/web/api-1", namespace: "web" });
    expect(tabScope(state().tabs[2])).toEqual(["web"]);
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

  /**
   * Would lose the namespace every tab was parked on the day `scope` shipped:
   * a payload written before it carries the same version this build writes,
   * so nothing but the field's absence says it has to be recovered.
   */
  it("reads a tab written before the selection had a field of its own", async () => {
    localStorage.setItem(
      "scope-tabs",
      JSON.stringify({
        state: {
          tabs: [
            {
              id: "scope-1",
              context: "prod",
              namespace: "web",
              href: "/nodes",
              missing: false,
            },
          ],
          activeId: "scope-1",
        },
        version: 1,
      })
    );
    await useScopeTabStore.persist.rehydrate();
    expect(state().tabs[0].scope).toEqual(["web"]);
  });

  /** A window must not name namespaces it is not going to read. */
  it("cuts a restored selection to what this build watches at once", async () => {
    localStorage.setItem(
      "scope-tabs",
      JSON.stringify({
        state: {
          tabs: [
            {
              id: "scope-1",
              context: "prod",
              namespace: "",
              scope: Array.from(
                { length: SCOPE_LIMIT + 2 },
                (_, i) => `ns-${i}`
              ),
              href: "/",
              missing: false,
            },
          ],
          activeId: "scope-1",
        },
        version: 1,
      })
    );
    await useScopeTabStore.persist.rehydrate();
    expect(state().tabs[0].scope).toHaveLength(SCOPE_LIMIT);
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
