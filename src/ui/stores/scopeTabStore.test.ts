// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createMemoryHistory, createRouter } from "@tanstack/react-router";
import { QueryClient } from "@tanstack/react-query";

vi.mock("@/lib/commands", () => ({
  commands: {
    connectCluster: vi.fn(async (context: string) => ({ context })),
    disconnectCluster: vi.fn(async () => undefined),
    saveClusterPreferences: vi.fn(async () => undefined),
  },
}));

import { routeTree } from "@/generated/routeTree.gen";
import { hrefOf, listLink, objectLink, setRouter } from "@/lib/links";
import { SCOPE_LIMIT } from "@/lib/namespace-scope";
import { RESOURCE_REGISTRY } from "@/lib/resource-registry";
import { useClusterStore } from "./clusterStore";
import {
  listBehind,
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
    state().recordHref("/c/prod/pods?peek=pods%2Fdefault%2Fapi-1");
    expect(state().tabs[0].href).toBe(
      "/c/prod/pods?peek=pods%2Fdefault%2Fapi-1"
    );
    expect(state().tabs[1].href).toBe("/");
  });

  it("ignores a navigation that belongs to the tab being left", async () => {
    seed([
      tab({ id: "a", href: "/c/prod/events" }),
      tab({ id: "b", href: "/c/prod/nodes" }),
    ]);
    await state().activateTab("b");
    // The router has not moved yet; the route it still reports is A's.
    state().recordHref("/c/prod/events");
    expect(state().tabs[1].href).toBe("/c/prod/nodes");
    expect(state().pendingHref).toBe("/c/prod/nodes");
  });

  it("asks for the tab's route on activation and parks the one it leaves", async () => {
    live("prod", "web");
    seed([
      tab({ id: "a", href: "/c/prod/events" }),
      tab({
        id: "b",
        context: "prod",
        namespace: "api",
        href: "/c/prod/nodes",
      }),
    ]);
    await state().activateTab("b");
    expect(state().activeId).toBe("b");
    expect(state().pendingHref).toBe("/c/prod/nodes");
    expect(state().tabs[0]).toMatchObject({
      context: "prod",
      namespace: "web",
    });
    expect(useClusterStore.getState().currentNamespace).toBe("api");
  });

  it("clears the pending route once the router has landed", async () => {
    seed([tab({ id: "a" }), tab({ id: "b", href: "/c/prod/nodes" })]);
    await state().activateTab("b");
    state().routeSettled();
    expect(state().pendingHref).toBeNull();
    state().recordHref("/c/prod/nodes/agent-0");
    expect(state().tabs[1].href).toBe("/c/prod/nodes/agent-0");
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
      href: "/c/prod",
    });
    expect(state().activeId).toBe(state().tabs[1].id);
  });

  it("keeps a background tab behind the one being read", async () => {
    live("prod");
    seed([tab({ id: "a", href: "/c/prod/events" })]);
    await state().openTab({ href: "/c/prod/pods/web/api-1", background: true });
    expect(state().activeId).toBe("a");
    expect(state().pendingHref).toBeNull();
    expect(state().tabs[1].href).toBe("/c/prod/pods/web/api-1");
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
        tab({ id: "a", href: "/c/a" }),
        tab({ id: "b", href: "/c/b" }),
        tab({ id: "c", href: "/c/c" }),
      ],
      "b"
    );
    await state().closeTab("b");
    expect(state().activeId).toBe("c");
    expect(state().pendingHref).toBe("/c/c");
  });

  it("falls back to the new last tab when the rightmost closes", async () => {
    seed([tab({ id: "a", href: "/c/a" }), tab({ id: "b", href: "/c/b" })], "b");
    await state().closeTab("b");
    expect(state().activeId).toBe("a");
    expect(state().pendingHref).toBe("/c/a");
  });

  it("leaves a parked tab closed without moving the reader", async () => {
    seed([tab({ id: "a", href: "/c/a" }), tab({ id: "b", href: "/c/b" })], "a");
    await state().closeTab("b");
    expect(state().tabs).toHaveLength(1);
    expect(state().activeId).toBe("a");
    expect(state().pendingHref).toBeNull();
  });

  /**
   * The reported #137 bug: the ✕ beside an open pod's name read as "close
   * this view" but the store treated it as "leave the cluster", resetting
   * context + namespace. A last tab on a page now returns to the overview
   * with its connection and selection intact — like the peek ✕ and the
   * detail back arrow. Fails if the route-aware branch of closeTab is deleted.
   */
  it("keeps the cluster and namespace when the last tab closes on a page", async () => {
    live("prod", "web");
    seed([
      tab({
        id: "a",
        context: "prod",
        namespace: "web",
        href: "/c/prod/pods/web/api",
      }),
    ]);
    await state().closeTab("a");
    expect(state().tabs).toHaveLength(1);
    expect(state().tabs[0]).toMatchObject({
      context: "prod",
      namespace: "web",
      href: "/c/prod",
    });
    expect(state().pendingHref).toBe("/c/prod");
    expect(useClusterStore.getState().currentContext).toBe("prod");
    expect(useClusterStore.getState().isConnected).toBe(true);
  });

  /**
   * The one that must still reset: a last tab already at the overview is the
   * fresh-install state and the only in-UI way back to the cluster picker.
   * Fails if the keep-scope branch swallows the overview case too.
   */
  it("disconnects only when the last tab is already at the overview", async () => {
    live("prod", "web");
    seed([
      tab({ id: "a", context: "prod", namespace: "web", href: "/c/prod" }),
    ]);
    await state().closeTab("a");
    expect(state().tabs[0]).toMatchObject({
      context: null,
      namespace: "",
      href: "/",
    });
    expect(useClusterStore.getState().currentContext).toBeNull();
  });

  /**
   * The RBAC-split reader from #137 stands in several namespaces at once;
   * closing a pod must carry that whole selection home, not throw it away.
   */
  it("carries a multi-namespace selection home when the last tab closes", async () => {
    liveScope("prod", ["web", "api"]);
    seed([
      tab({
        id: "a",
        context: "prod",
        namespace: "",
        scope: ["web", "api"],
        href: "/c/prod/pods/web/burst",
      }),
    ]);
    await state().closeTab("a");
    expect(state().tabs[0]).toMatchObject({
      context: "prod",
      href: "/c/prod",
      scope: ["web", "api"],
    });
    expect(useClusterStore.getState().isConnected).toBe(true);
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

  /** Picking a cluster on a lost tab's front door connected the window, and
   *  the tab went on naming the lost cluster over the new one's rows. */
  /** With the scope `connect` restored for that cluster: an empty one on
   *  the tab would be applied over it on the next launch. */
  it("becomes the cluster the window connects to from its front door", () => {
    seed([tab({ id: "a", context: "gone", missing: true, namespace: "old" })]);
    useClusterStore.setState({
      currentNamespace: "web",
      namespaceScope: ["web"],
    });
    state().adoptConnected("drain");
    expect(state().tabs[0]).toMatchObject({
      missing: false,
      context: "drain",
      namespace: "web",
      scope: ["web"],
    });
  });

  it("leaves a tab that names a live cluster alone", () => {
    seed([tab({ id: "a", context: "prod" })]);
    state().adoptConnected("drain");
    expect(state().tabs[0].context).toBe("prod");
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
    ["/c/prod", "overview"],
    ["/c/prod/pods", "pods"],
    ["/c/prod/nodes", "nodes"],
    ["/c/prod/events", "events"],
    ["/c/prod/helm", "helm"],
    ["/c/prod/pods/web/api-7f9", "api-7f9"],
    ["/c/prod/nodes/k3d-agent-0", "k3d-agent-0"],
    ["/c/prod/helm/native/web/redis", "redis"],
  ])("names %s as %s", (href, expected) => {
    expect(tabRouteLabel(href)).toBe(expected);
  });

  /** The cluster is the tab's own name; its route must not repeat it. */
  it("never names the cluster as the route", () => {
    expect(tabRouteLabel("/c/pods")).toBe("overview");
  });

  // The peek is the foreground, so it is what the tab is showing.
  it("names the open peek over the list behind it", () => {
    expect(tabRouteLabel("/c/prod/pods?peek=pods%2Fweb%2Fapi-7f9")).toBe(
      "api-7f9"
    );
  });

  it("never falls back to a raw pathname", () => {
    expect(tabRouteLabel("/c/prod/some/unknown/place")).toBe("place");
  });

  it("spells the whole tab for a tooltip", () => {
    expect(
      tabTitle(
        tab({ context: "prod", namespace: "web", href: "/c/prod/nodes" }),
        t
      )
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
    await state().openTab({ href: "/c/prod/pods/web/api-1", namespace: "web" });
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

  /**
   * An address from before `/c/<cluster>` matches nothing the app serves,
   * so a tab restored onto one would open on "not found". Fails if the
   * migration keeps any path that does not name a cluster.
   */
  it("lands a tab whose address names no cluster on the front door", () => {
    const migrated = migrate(
      {
        tabs: [
          { id: "a", context: "prod", namespace: "", href: "/workloads/pods" },
          { id: "b", context: "prod", namespace: "", href: "/c/prod/nodes" },
        ],
        activeId: "a",
      },
      1
    );
    expect(migrated.tabs.map((tab) => tab.href)).toEqual([
      "/",
      "/c/prod/nodes",
    ]);
  });

  /**
   * The front door sends the window to the cluster it was last in, which
   * need not be the restored tab's: asked for, it would put one cluster's
   * address over the other's connection.
   */
  it("opens a migrated tab on its own cluster's overview", async () => {
    localStorage.setItem(
      "scope-tabs",
      JSON.stringify({
        state: {
          tabs: [
            {
              id: "scope-1",
              context: "prod",
              namespace: "web",
              href: "/workloads/pods",
              missing: false,
            },
          ],
          activeId: "scope-1",
        },
        version: 1,
      })
    );
    await useScopeTabStore.persist.rehydrate();
    expect(state().tabs[0].href).toBe("/c/prod");
    expect(state().pendingHref).toBe("/c/prod");
  });

  /** A tab that never had a cluster asks for nothing; the window boots at its front door. */
  it("asks for nothing when the restored tab has no cluster", async () => {
    localStorage.setItem(
      "scope-tabs",
      JSON.stringify({
        state: {
          tabs: [
            {
              id: "scope-1",
              context: null,
              namespace: "",
              href: "/",
              missing: false,
            },
          ],
          activeId: "scope-1",
        },
        version: 2,
      })
    );
    await useScopeTabStore.persist.rehydrate();
    expect(state().tabs[0].href).toBe("/");
    expect(state().pendingHref).toBeNull();
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
              href: "/c/prod/events",
              missing: false,
            },
            {
              id: "scope-2",
              context: "prod",
              namespace: "web",
              href: "/c/prod/pods",
              missing: false,
            },
          ],
          activeId: "scope-2",
        },
        version: 2,
      })
    );
    await useScopeTabStore.persist.rehydrate();
    expect(state().tabs).toHaveLength(2);
    expect(state().activeId).toBe("scope-2");
    // The window boots at "/", so the restored route has to be asked for.
    expect(state().pendingHref).toBe("/c/prod/pods");
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
              href: "/c/prod/nodes",
              missing: false,
            },
          ],
          activeId: "scope-1",
        },
        version: 2,
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
              href: "/c/prod",
              missing: false,
            },
          ],
          activeId: "scope-1",
        },
        version: 2,
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
              href: "/c/prod/nodes",
              missing: false,
            },
          ],
          activeId: "scope-99",
        },
        version: 2,
      })
    );
    await useScopeTabStore.persist.rehydrate();
    expect(state().activeId).toBe("scope-1");
    expect(state().pendingHref).toBe("/c/prod/nodes");
  });
});

describe("a route that belongs to the cluster being left", () => {
  /**
   * Issue #148's `ps.`: switching clusters left the pod page open on a pod
   * that exists in neither the new cluster nor the reader's mind. The list is
   * what survives the move — and a list route must not be moved at all, or
   * every switch would throw away where the reader was.
   */
  it.each([
    ["/c/prod/pods/default/api-7f9", "/c/prod/pods"],
    ["/c/prod/nodes/worker-1", "/c/prod/nodes"],
    [
      "/c/prod/customresourcedefinitions/widgets.example.com",
      "/c/prod/customresourcedefinitions",
    ],
    ["/c/prod/widgets.example.com/default/w-1", "/c/prod/widgets.example.com"],
    ["/c/prod/helm/secret/default/redis", "/c/prod/helm"],
    ["/c/prod/pods?peek=pods/default/api-7f9", "/c/prod/pods"],
    // A peek over a detail page: closing the panel leaves the page under it,
    // which is the old cluster's object with the thing that named it gone.
    [
      "/c/prod/pods/default/api-7f9?peek=configmaps/default/cfg",
      "/c/prod/pods",
    ],
    ["/c/prod/replicasets/default/api-7f9", "/c/prod/deployments"],
    ["/c/prod/httproutes/default/web", "/c/prod/routes"],
  ])("sends %s to %s", (href, list) => {
    expect(listBehind(href)).toBe(list);
  });

  /** A context name from EKS is an ARN, with slashes and colons in it. */
  it("keeps a cluster name with slashes in it as one segment", () => {
    const arn = encodeURIComponent("arn:aws:eks:eu-west-1:123:cluster/prod");
    expect(listBehind(`/c/${arn}/pods/default/api-7f9`)).toBe(`/c/${arn}/pods`);
  });

  it.each([
    "/",
    "/c/prod",
    "/c/prod/pods",
    "/c/prod/nodes",
    "/c/prod/events",
    "/c/prod/customresourcedefinitions",
    // A vendor's page is about the integration, not one cluster's object.
    "/c/prod/integrations/traefik",
  ])("leaves %s where it is", (href) => {
    expect(listBehind(href)).toBeNull();
  });
});

describe("retargetAfterSwitch", () => {
  /** Without this the tab keeps the old cluster's pod and goes nowhere. */
  it("moves the active tab to the list and asks the router for it", () => {
    seed([
      tab({
        id: "a",
        context: "left-behind",
        href: "/c/left-behind/pods/default/api-7f9",
      }),
    ]);
    useScopeTabStore.getState().retargetAfterSwitch("arrived-at");
    const { tabs, pendingHref } = useScopeTabStore.getState();
    expect(tabs[0].href).toBe("/c/arrived-at/pods");
    expect(pendingHref).toBe("/c/arrived-at/pods");
  });

  /**
   * Activating a tab changes the cluster too, and that tab's own route is
   * already on its way — overwriting it would send the reader to a list they
   * did not ask for every time they switched tabs.
   */
  it("stands aside while an activation is delivering a route", () => {
    seed([
      tab({
        id: "a",
        context: "left-behind",
        href: "/c/left-behind/pods/default/api-7f9",
      }),
    ]);
    useScopeTabStore.setState({ pendingHref: "/c/arrived-at/nodes/worker-1" });
    useScopeTabStore.getState().retargetAfterSwitch("arrived-at");
    expect(useScopeTabStore.getState().tabs[0].href).toBe(
      "/c/left-behind/pods/default/api-7f9"
    );
  });

  /**
   * The address is what connects the window now, so a page already in the
   * cluster that connected got there by its own address and belongs to it:
   * a link followed, or the retry of a failed activation.
   */
  it("leaves a tab alone when the cluster it landed on is the one it names", () => {
    seed([
      tab({ id: "a", context: "old", href: "/c/prod/pods/default/api-7f9" }),
    ]);
    useScopeTabStore.getState().retargetAfterSwitch("prod");
    const { tabs, pendingHref } = useScopeTabStore.getState();
    expect(tabs[0].href).toBe("/c/prod/pods/default/api-7f9");
    expect(pendingHref).toBeNull();
  });

  /**
   * A list means the same thing in any cluster, so the reader keeps it; only
   * its cluster follows the connection, or the address would name one
   * cluster over another's rows.
   */
  it("keeps a list a list in the cluster it arrived at", () => {
    seed([
      tab({ id: "a", context: "left-behind", href: "/c/left-behind/pods" }),
    ]);
    useScopeTabStore.getState().retargetAfterSwitch("arrived-at");
    const { tabs, pendingHref } = useScopeTabStore.getState();
    expect(tabs[0].href).toBe("/c/arrived-at/pods");
    expect(pendingHref).toBe("/c/arrived-at/pods");
  });
});

describe("every route this could send a tab to", () => {
  /**
   * The retarget is only an improvement if it lands somewhere of its own.
   * `replicasets` and `httproutes` are the kinds' own plurals and neither
   * lists anything, so a tab sent there lands on a redirect at best and on
   * the generic "not listed" page at worst, which is worse than the stale
   * detail page. The detail page's breadcrumb asks the same question, and a
   * GatewayClass's once led to such a pane. This matches against the
   * generated route tree, so a kind that gains a detail route without a list
   * one fails here rather than in somebody's window.
   */
  it("is a route the app actually serves", async () => {
    const router = createRouter({
      routeTree,
      context: { queryClient: new QueryClient() },
      history: createMemoryHistory({ initialEntries: ["/c/prod"] }),
    });
    setRouter(router);
    await router.load();
    const generic = (href: string) =>
      /\/\$resource\//.test(
        router.matchRoutes(href.split("?")[0]).at(-1)?.routeId ?? ""
      );

    // Every kind with a detail page of its own, as the href a reader is on.
    const paged = RESOURCE_REGISTRY.flatMap((entry) => {
      const link = objectLink({ kind: entry.kind, name: "x", namespace: "ns" });
      const href = link ? hrefOf(link) : null;
      return href && !generic(href) ? [{ kind: entry.kind, href }] : [];
    });
    // The count guards the extraction itself: a match that stopped working
    // would otherwise leave this passing over an empty list.
    expect(paged.length).toBeGreaterThanOrEqual(25);
    expect(paged.map((p) => p.kind)).toEqual(
      expect.arrayContaining(["ReplicaSet", "GatewayClass", "TLSRoute"])
    );

    const missing = paged
      .map(({ href }) => [href, listBehind(href)] as const)
      .filter(([, list]) => list === null || generic(list));
    expect(missing).toEqual([]);

    const crumbs = paged
      .map(({ kind }) => hrefOf(listLink(kind)))
      .filter(generic);
    expect(crumbs).toEqual([]);
  });
});

describe("a tab whose cluster the kubeconfig no longer has", () => {
  /**
   * The state this launches into: a pod page restored from last time, in a
   * cluster that is not in the kubeconfig any more. Nothing can answer it, so
   * the page reads "could not read this pod" until the reader works out why.
   */
  it("lets go of the object it was on and takes the reader there", () => {
    seed([
      tab({ id: "a", context: "gone", href: "/c/gone/pods/default/api-7f9" }),
    ]);
    useScopeTabStore.getState().reconcileContexts(["still-here"]);
    const { tabs, pendingHref } = useScopeTabStore.getState();
    expect(tabs[0].missing).toBe(true);
    expect(tabs[0].href).toBe("/c/gone/pods");
    // Rewriting the record leaves the router on the dead page.
    expect(pendingHref).toBe("/c/gone/pods");
  });

  /**
   * The flag is not the trigger: a tab flagged by an older build, or one that
   * recorded an object route while already flagged, has to be let go of too.
   */
  it("lets go on a later pass, not only on the one that flags it", () => {
    seed([
      tab({
        id: "a",
        context: "gone",
        href: "/c/gone/pods/default/api-7f9",
        missing: true,
      }),
    ]);
    useScopeTabStore.getState().reconcileContexts(["still-here"]);
    expect(useScopeTabStore.getState().tabs[0].href).toBe("/c/gone/pods");
  });

  /** A cluster that came back keeps whatever the tab is on. */
  it("leaves a tab alone when its cluster is there", () => {
    seed([
      tab({
        id: "a",
        context: "here",
        href: "/c/here/pods/default/api-7f9",
        missing: true,
      }),
    ]);
    useScopeTabStore.getState().reconcileContexts(["here"]);
    const [only] = useScopeTabStore.getState().tabs;
    expect(only.missing).toBe(false);
    expect(only.href).toBe("/c/here/pods/default/api-7f9");
  });
});
