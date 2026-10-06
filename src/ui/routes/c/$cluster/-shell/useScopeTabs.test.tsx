import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { act, render } from "@testing-library/react";
import {
  createBrowserHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
  type AnyRouter,
} from "@tanstack/react-router";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";

vi.mock("@/lib/commands", () => ({
  commands: {
    connectCluster: vi.fn(async (context: string) => ({ context })),
    disconnectCluster: vi.fn(async () => undefined),
    saveClusterPreferences: vi.fn(async () => undefined),
  },
}));

import { useScopeTabs } from "./useScopeTabs";
import { useScopeTabStore, type ScopeTab } from "@/stores/scopeTabStore";
import { useClusterStore } from "@/stores/clusterStore";
import { renderWithRouter, testQueryClient } from "@/test/render";

const tab = (over: Partial<ScopeTab> = {}): ScopeTab => ({
  id: "t1",
  context: null,
  namespace: "",
  href: "/",
  missing: false,
  ...over,
});

function Probe() {
  useScopeTabs();
  return null;
}

let client: QueryClient;
let router: AnyRouter;

async function mount(entry = "/") {
  client = testQueryClient();
  ({ router } = await renderWithRouter(<Probe />, {
    client,
    at: entry,
    route: "$",
  }));
}

const href = () => router.state.location.href;
const state = () => useScopeTabStore.getState();

beforeEach(() => {
  localStorage.clear();
  useClusterStore.setState({
    contexts: [],
    currentContext: null,
    currentNamespace: "",
    isConnected: false,
  });
  useScopeTabStore.setState({
    tabs: [tab({ id: "a", href: "/" })],
    activeId: "a",
    pendingHref: null,
  });
});

describe("the router bridge", () => {
  it("records a navigation onto the tab it happened in", async () => {
    await mount("/");
    await act(async () => {
      await router.navigate({ href: "/c/prod/pods" });
    });
    await vi.waitFor(() => expect(state().tabs[0].href).toBe("/c/prod/pods"));
  });

  it("takes the reader to the activated tab's route, query string and all", async () => {
    useScopeTabStore.setState({
      tabs: [
        tab({ id: "a", href: "/" }),
        tab({ id: "b", href: "/c/prod/pods?peek=pods%2Fweb%2Fapi-1" }),
      ],
      activeId: "a",
    });
    await mount("/");
    await act(async () => {
      await state().activateTab("b");
    });
    await vi.waitFor(() =>
      expect(href()).toBe("/c/prod/pods?peek=pods%2Fweb%2Fapi-1")
    );
    await vi.waitFor(() => expect(state().pendingHref).toBeNull());
  });

  it("goes to the restored route on boot without recording the boot one over it", async () => {
    useScopeTabStore.setState({
      tabs: [tab({ id: "a", href: "/c/prod/nodes" })],
      activeId: "a",
      pendingHref: "/c/prod/nodes",
    });
    await mount("/");
    await vi.waitFor(() => expect(href()).toBe("/c/prod/nodes"));
    await vi.waitFor(() => expect(state().pendingHref).toBeNull());
    expect(state().tabs[0].href).toBe("/c/prod/nodes");
  });

  /**
   * The router does not always land where it was asked: a redirect moves it
   * on, and it writes a query value back in its own encoding. A bridge that
   * settled only on arriving at the very address asked for asked again,
   * forever.
   */
  it("settles where the router lands when that is not the address asked for", async () => {
    const asked = "/c/prod/pods?peek=pods/web/api-1";
    useScopeTabStore.setState({
      tabs: [tab({ id: "a", href: asked })],
      activeId: "a",
      pendingHref: asked,
    });
    await mount("/");
    await vi.waitFor(() => expect(state().pendingHref).toBeNull());
    expect(href()).not.toBe(asked);
    expect(state().tabs[0].href).toBe(href());
  });

  // One live connection means everything cached belonged to a scope that is
  // no longer being watched, so none of it may be redrawn as current.
  it("empties the query cache on a tab switch", async () => {
    useScopeTabStore.setState({
      tabs: [tab({ id: "a" }), tab({ id: "b", href: "/c/prod/nodes" })],
      activeId: "a",
    });
    await mount("/");
    client.setQueryData(["pods", "web"], [{ name: "api-1" }]);
    await act(async () => {
      await state().activateTab("b");
    });
    expect(client.getQueryData(["pods", "web"])).toBeUndefined();
  });
});

describe("a tab whose cluster is gone", () => {
  /** The hook is what hands the connection to the tab; without it the tab
   *  keeps the lost cluster's name after the window connected elsewhere. */
  it("takes the cluster a connect from it lands on", async () => {
    useScopeTabStore.setState({
      tabs: [tab({ id: "a", context: "gone", missing: true })],
      activeId: "a",
    });
    await mount("/");
    await act(async () => {
      await useClusterStore.getState().connect("drain");
    });
    expect(state().tabs[0]).toMatchObject({ missing: false, context: "drain" });
  });

  /** Activating the lost tab drops the window's connection after the tab is
   *  already active; the connection being dropped is not the tab's. */
  it("does not take the cluster still open when it is activated", async () => {
    useClusterStore.setState({ currentContext: "prod", isConnected: true });
    useScopeTabStore.setState({
      tabs: [
        tab({ id: "a", context: "prod" }),
        tab({ id: "b", context: "gone", missing: true }),
      ],
      activeId: "a",
    });
    await mount("/");
    await act(async () => {
      await state().activateTab("b");
    });
    expect(state().tabs[1]).toMatchObject({ missing: true, context: "gone" });
  });
});

describe("the keyboard", () => {
  const press = async (init: KeyboardEventInit) => {
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", init));
      await Promise.resolve();
    });
  };

  it("opens a tab on mod+T and closes one on mod+W", async () => {
    await mount("/");
    await press({ key: "t", ctrlKey: true });
    expect(state().tabs).toHaveLength(2);
    await press({ key: "w", metaKey: true });
    expect(state().tabs).toHaveLength(1);
  });

  it("steps with ctrl+Tab in both directions", async () => {
    useScopeTabStore.setState({
      tabs: [tab({ id: "a" }), tab({ id: "b" }), tab({ id: "c" })],
      activeId: "a",
    });
    await mount("/");
    await press({ key: "Tab", ctrlKey: true });
    expect(state().activeId).toBe("b");
    await press({ key: "Tab", ctrlKey: true, shiftKey: true });
    expect(state().activeId).toBe("a");
  });

  it("jumps by position, with nine meaning the last", async () => {
    useScopeTabStore.setState({
      tabs: [tab({ id: "a" }), tab({ id: "b" }), tab({ id: "c" })],
      activeId: "a",
    });
    await mount("/");
    await press({ key: "2", ctrlKey: true });
    expect(state().activeId).toBe("b");
    await press({ key: "9", ctrlKey: true });
    expect(state().activeId).toBe("c");
  });
});

describe("the kubeconfig", () => {
  it("flags a tab whose cluster the kubeconfig no longer lists", async () => {
    useScopeTabStore.setState({
      tabs: [tab({ id: "a", context: "gone" })],
      activeId: "a",
    });
    await mount("/");
    await act(async () => {
      useClusterStore.setState({
        contexts: [
          {
            name: "prod",
            cluster: "prod",
            user: "prod",
            namespace: null,
            is_current: true,
            server: null,
            exec_command: null,
            auth: { kind: "unrecognised" },
          },
        ],
      });
    });
    expect(state().tabs[0].missing).toBe(true);
  });
});

describe("Back in a tab", () => {
  /** The window's own history, as the app runs on, so Back is a real popstate. */
  async function mountOnWindowHistory(entry: string) {
    window.history.replaceState(null, "", entry);
    client = testQueryClient();
    const root = createRootRoute();
    const page = createRoute({
      getParentRoute: () => root,
      path: "$",
      component: Probe,
    });
    router = createRouter({
      routeTree: root.addChildren([page]),
      history: createBrowserHistory(),
    });
    await act(() => router.load());
    const view = render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    );
    return () => {
      view.unmount();
      router.history.destroy();
    };
  }

  async function activate(id: string, at: string) {
    await act(async () => {
      await state().activateTab(id);
    });
    await vi.waitFor(() => expect(href()).toBe(at));
    await vi.waitFor(() => expect(state().pendingHref).toBeNull());
  }

  /**
   * Sam opened ClusterRoles then one ClusterRole in tab 2, looked at tab 1
   * and came back: Back loaded tab 1's PersistentVolume into tab 2, and both
   * tabs ended on it.
   */
  it("returns to the tab's own last route after a visit to another tab", async () => {
    useScopeTabStore.setState({
      tabs: [
        tab({ id: "a", href: "/c/prod/persistentvolumes/pv-demo" }),
        tab({ id: "b", href: "/c/prod/clusterroles" }),
      ],
      activeId: "a",
    });
    const unmount = await mountOnWindowHistory(
      "/c/prod/persistentvolumes/pv-demo"
    );

    await activate("b", "/c/prod/clusterroles");
    await act(async () => {
      await router.navigate({ href: "/c/prod/clusterroles/admin" });
    });
    await vi.waitFor(() =>
      expect(state().tabs[1].href).toBe("/c/prod/clusterroles/admin")
    );
    await activate("a", "/c/prod/persistentvolumes/pv-demo");
    await activate("b", "/c/prod/clusterroles/admin");

    act(() => router.history.back());

    await vi.waitFor(() => expect(href()).toBe("/c/prod/clusterroles"));
    await vi.waitFor(() => expect(state().pendingHref).toBeNull());
    expect(state().tabs.map((each) => each.href)).toEqual([
      "/c/prod/persistentvolumes/pv-demo",
      "/c/prod/clusterroles",
    ]);
    unmount();
  });
});
