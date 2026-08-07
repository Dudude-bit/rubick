import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

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
  const { pathname, search } = useLocation();
  return <span data-testid="href">{`${pathname}${search}`}</span>;
}

let client: QueryClient;

function mount(entry = "/") {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <Probe />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

const href = () => screen.getByTestId("href").textContent;
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
    mount("/");
    await act(async () => {
      state().recordHref("/workloads/pods");
    });
    expect(state().tabs[0].href).toBe("/workloads/pods");
  });

  it("takes the reader to the activated tab's route, query string and all", async () => {
    useScopeTabStore.setState({
      tabs: [
        tab({ id: "a", href: "/" }),
        tab({ id: "b", href: "/workloads/pods?peek=pods%2Fweb%2Fapi-1" }),
      ],
      activeId: "a",
    });
    mount("/");
    await act(async () => {
      await state().activateTab("b");
    });
    expect(href()).toBe("/workloads/pods?peek=pods%2Fweb%2Fapi-1");
    expect(state().pendingHref).toBeNull();
  });

  it("goes to the restored route on boot without recording the boot one over it", async () => {
    useScopeTabStore.setState({
      tabs: [tab({ id: "a", href: "/nodes" })],
      activeId: "a",
      pendingHref: "/nodes",
    });
    mount("/");
    await act(async () => {});
    expect(href()).toBe("/nodes");
    expect(state().tabs[0].href).toBe("/nodes");
    expect(state().pendingHref).toBeNull();
  });

  // One live connection means everything cached belonged to a scope that is
  // no longer being watched, so none of it may be redrawn as current.
  it("empties the query cache on a tab switch", async () => {
    useScopeTabStore.setState({
      tabs: [tab({ id: "a" }), tab({ id: "b", href: "/nodes" })],
      activeId: "a",
    });
    mount("/");
    client.setQueryData(["pods", "web"], [{ name: "api-1" }]);
    await act(async () => {
      await state().activateTab("b");
    });
    expect(client.getQueryData(["pods", "web"])).toBeUndefined();
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
    mount("/");
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
    mount("/");
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
    mount("/");
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
    mount("/");
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
          },
        ],
      });
    });
    expect(state().tabs[0].missing).toBe(true);
  });
});
