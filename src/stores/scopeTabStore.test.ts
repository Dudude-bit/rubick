import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

vi.mock("@/lib/commands", () => ({
  commands: {
    connectCluster: vi.fn(async (context: string) => ({ context })),
    disconnectCluster: vi.fn(async () => undefined),
    saveClusterPreferences: vi.fn(async () => undefined),
  },
}));

import { SCOPE_LIMIT } from "@/lib/namespace-scope";
import { ResourceType, toPlural } from "@/lib/resource-registry";
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
        href: "/pods/web/api",
      }),
    ]);
    await state().closeTab("a");
    expect(state().tabs).toHaveLength(1);
    expect(state().tabs[0]).toMatchObject({
      context: "prod",
      namespace: "web",
      href: "/",
    });
    expect(state().pendingHref).toBe("/");
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
    seed([tab({ id: "a", context: "prod", namespace: "web", href: "/" })]);
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
        href: "/pods/web/burst",
      }),
    ]);
    await state().closeTab("a");
    expect(state().tabs[0]).toMatchObject({
      context: "prod",
      href: "/",
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

describe("a route that belongs to the cluster being left", () => {
  /**
   * Issue #148's `ps.`: switching clusters left the pod page open on a pod
   * that exists in neither the new cluster nor the reader's mind. The list is
   * what survives the move — and a list route must not be moved at all, or
   * every switch would throw away where the reader was.
   */
  it.each([
    ["/pods/default/api-7f9", "/workloads/pods"],
    ["/nodes/worker-1", "/nodes"],
    [
      "/customresourcedefinitions/widgets.example.com",
      "/customresourcedefinitions",
    ],
    ["/helm/secret/default/redis", "/helm"],
    ["/workloads/pods?peek=pods/default/api-7f9", "/workloads/pods"],
    // A peek over a detail page: closing the panel leaves the page under it,
    // which is the old cluster's object with the thing that named it gone.
    ["/pods/default/api-7f9?peek=configmaps/default/cfg", "/workloads/pods"],
    ["/replicasets/default/api-7f9", "/workloads/deployments"],
    ["/httproutes/default/web", "/network/routes"],
  ])("sends %s to %s", (href, list) => {
    expect(listBehind(href)).toBe(list);
  });

  it.each([
    "/",
    "/workloads/pods",
    "/nodes",
    "/events",
    "/settings/appearance",
    "/customresourcedefinitions",
  ])("leaves %s where it is", (href) => {
    expect(listBehind(href)).toBeNull();
  });
});

describe("retargetAfterSwitch", () => {
  /** Without this the tab keeps the old cluster's pod and goes nowhere. */
  it("moves the active tab to the list and asks the router for it", () => {
    seed([
      tab({ id: "a", context: "left-behind", href: "/pods/default/api-7f9" }),
    ]);
    useScopeTabStore.getState().retargetAfterSwitch("arrived-at");
    const { tabs, pendingHref } = useScopeTabStore.getState();
    expect(tabs[0].href).toBe("/workloads/pods");
    expect(pendingHref).toBe("/workloads/pods");
  });

  /**
   * Activating a tab changes the cluster too, and that tab's own route is
   * already on its way — overwriting it would send the reader to a list they
   * did not ask for every time they switched tabs.
   */
  it("stands aside while an activation is delivering a route", () => {
    seed([
      tab({ id: "a", context: "left-behind", href: "/pods/default/api-7f9" }),
    ]);
    useScopeTabStore.setState({ pendingHref: "/nodes/worker-1" });
    useScopeTabStore.getState().retargetAfterSwitch("arrived-at");
    expect(useScopeTabStore.getState().tabs[0].href).toBe(
      "/pods/default/api-7f9"
    );
  });

  /**
   * The retry of a failed activation reconnects the tab's own cluster without
   * a route of its own to carry, so the counter moves — and the tab's page
   * belonged to that cluster all along.
   */
  it("leaves a tab alone when the cluster it landed on is the one it names", () => {
    seed([tab({ id: "a", context: "prod", href: "/pods/default/api-7f9" })]);
    useScopeTabStore.getState().retargetAfterSwitch("prod");
    const { tabs, pendingHref } = useScopeTabStore.getState();
    expect(tabs[0].href).toBe("/pods/default/api-7f9");
    expect(pendingHref).toBeNull();
  });

  it("leaves a tab that was already on a list alone", () => {
    seed([tab({ id: "a", context: "left-behind", href: "/workloads/pods" })]);
    useScopeTabStore.getState().retargetAfterSwitch("arrived-at");
    expect(useScopeTabStore.getState().pendingHref).toBeNull();
  });
});

describe("every route this could send a tab to", () => {
  /**
   * The retarget is only an improvement if it lands somewhere. `/workloads/
   * replicasets` and `/network/httproutes` are what `getResourceListUrl`
   * answers and neither matches a route, so a tab sent there renders an empty
   * pane — worse than the stale detail page. This reads the app's own route
   * tables, so a kind that gains a detail route without a list one fails here
   * rather than in somebody's window.
   */
  it("is a route the app actually serves", () => {
    const read = (file: string) =>
      readFileSync(resolve(process.cwd(), file), "utf8");
    const plural = (source: string) =>
      [...source.matchAll(/toPlural\(ResourceType\.(\w+)\)/g)].map((m) =>
        toPlural(ResourceType[m[1] as keyof typeof ResourceType])
      );

    const sections = {
      workloads: "src/pages/Workloads.tsx",
      network: "src/pages/Network.tsx",
      storage: "src/pages/Storage.tsx",
      configuration: "src/pages/Configuration.tsx",
    };
    const served = new Set<string>(["/", "/helm", "/events"]);
    for (const [section, file] of Object.entries(sections)) {
      const source = read(file);
      for (const p of plural(source)) served.add(`/${section}/${p}`);
      for (const m of source.matchAll(/path="([a-z-]+)"/g)) {
        served.add(`/${section}/${m[1]}`);
      }
    }

    const app = read("src/App.tsx");
    // Top-level list routes: a `path={toPlural(...)}` with nothing after it.
    for (const m of app.matchAll(/path=\{toPlural\(ResourceType\.(\w+)\)\}/g)) {
      served.add(
        `/${toPlural(ResourceType[m[1] as keyof typeof ResourceType])}`
      );
    }

    // Every detail route the app serves, as the href a reader would be on —
    // including the ones built by mapping over a list of kinds, which is
    // exactly where the kinds LIST_ELSEWHERE exists for are declared.
    const plural_ = (kind: string) =>
      toPlural(ResourceType[kind as keyof typeof ResourceType]);
    const named = [
      ...app.matchAll(
        /path=\{`\$\{toPlural\(ResourceType\.(\w+)\)\}\/([^`]*)`\}/g
      ),
    ].map(([, kind, tail]): [string, string] => [plural_(kind), tail]);
    const mapped = [
      ...app.matchAll(
        /\[([^\]]*?ResourceType\.\w+[^\]]*?)\]\.map\(\(kind\) => \([\s\S]*?path=\{`\$\{toPlural\(kind\)\}\/([^`]*)`\}/g
      ),
    ].flatMap(([, list, tail]) =>
      [...list.matchAll(/ResourceType\.(\w+)/g)].map(
        ([, kind]): [string, string] => [plural_(kind), tail]
      )
    );
    expect(mapped.map(([p]) => p)).toContain("tlsroutes");

    const details = [...named, ...mapped].map(
      ([p, tail]) => `/${p}/${tail.replace(/:\w+/g, "x")}`
    );
    // The count guards the extraction itself: a regex that stopped matching
    // would otherwise leave this passing over an empty list.
    expect(details.length).toBeGreaterThanOrEqual(25);

    const missing = details
      .map((href) => [href, listBehind(href)] as const)
      .filter(([, list]) => list !== null && !served.has(list));
    expect(missing).toEqual([]);
  });
});

describe("a tab whose cluster the kubeconfig no longer has", () => {
  /**
   * The state this launches into: a pod page restored from last time, in a
   * cluster that is not in the kubeconfig any more. Nothing can answer it, so
   * the page reads "could not read this pod" until the reader works out why.
   */
  it("lets go of the object it was on and takes the reader there", () => {
    seed([tab({ id: "a", context: "gone", href: "/pods/default/api-7f9" })]);
    useScopeTabStore.getState().reconcileContexts(["still-here"]);
    const { tabs, pendingHref } = useScopeTabStore.getState();
    expect(tabs[0].missing).toBe(true);
    expect(tabs[0].href).toBe("/workloads/pods");
    // Rewriting the record leaves the router on the dead page.
    expect(pendingHref).toBe("/workloads/pods");
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
        href: "/pods/default/api-7f9",
        missing: true,
      }),
    ]);
    useScopeTabStore.getState().reconcileContexts(["still-here"]);
    expect(useScopeTabStore.getState().tabs[0].href).toBe("/workloads/pods");
  });

  /** A cluster that came back keeps whatever the tab is on. */
  it("leaves a tab alone when its cluster is there", () => {
    seed([
      tab({
        id: "a",
        context: "here",
        href: "/pods/default/api-7f9",
        missing: true,
      }),
    ]);
    useScopeTabStore.getState().reconcileContexts(["here"]);
    const [only] = useScopeTabStore.getState().tabs;
    expect(only.missing).toBe(false);
    expect(only.href).toBe("/pods/default/api-7f9");
  });
});
