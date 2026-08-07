import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/lib/commands", () => ({
  commands: {
    connectCluster: vi.fn(async (context: string) => ({ context })),
    disconnectCluster: vi.fn(async () => undefined),
    saveClusterPreferences: vi.fn(async () => undefined),
    listContexts: vi.fn(async () => []),
  },
}));

vi.mock("@/hooks/useClusterSummary", () => ({
  useClusterSummary: () => ({
    namespaces: [],
    podCount: 0,
    problemCount: 0,
    problemsTruncated: 0,
  }),
}));

import { TooltipProvider } from "@/components/ui/tooltip";
import { ScopeTabs } from "./ScopeTabs";
import { useClusterStore } from "@/stores/clusterStore";
import { useScopeTabStore, type ScopeTab } from "@/stores/scopeTabStore";

const tab = (over: Partial<ScopeTab> = {}): ScopeTab => ({
  id: "t1",
  context: "k3d-dev",
  namespace: "",
  href: "/",
  missing: false,
  ...over,
});

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <TooltipProvider>
          <ScopeTabs />
        </TooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

const tabs = () => screen.getAllByRole("tab");

beforeEach(() => {
  localStorage.clear();
  useClusterStore.setState({
    contexts: [],
    currentContext: "k3d-dev",
    currentNamespace: "",
    isConnected: true,
    isLoading: false,
    isAuthenticating: false,
    error: null,
    pendingContext: null,
  });
});

describe("what a tab says", () => {
  it("drops the cluster name while the strip holds one cluster", () => {
    useScopeTabStore.setState({
      tabs: [
        tab({ id: "a", href: "/" }),
        tab({ id: "b", href: "/workloads/pods" }),
      ],
      activeId: "a",
      pendingHref: null,
    });
    mount();

    // The sidebar has just said it and the dot still guards the mistake,
    // so the name is not worth the width it would take from the route.
    expect(screen.queryByText("k3d-dev")).not.toBeInTheDocument();
    expect(within(tabs()[0]).getByText("overview")).toBeInTheDocument();
    expect(within(tabs()[1]).getByText("pods")).toBeInTheDocument();
  });

  it("names every cluster the moment a second one is open", () => {
    useScopeTabStore.setState({
      tabs: [tab({ id: "a" }), tab({ id: "b", context: "prod-eu" })],
      activeId: "a",
      pendingHref: null,
    });
    mount();

    expect(screen.getByText("k3d-dev")).toBeInTheDocument();
    expect(screen.getByText("prod-eu")).toBeInTheDocument();
  });

  it("keeps the route on every tab, which is what tells them apart", () => {
    useScopeTabStore.setState({
      tabs: [
        tab({ id: "a", href: "/workloads/pods" }),
        tab({ id: "b", href: "/workloads/pods/kube-system/coredns-abc" }),
      ],
      activeId: "a",
      pendingHref: null,
    });
    mount();

    expect(within(tabs()[0]).getByText("pods")).toBeInTheDocument();
    expect(within(tabs()[1]).getByText("coredns-abc")).toBeInTheDocument();
  });

  it("carries the whole label in the accessible name the strip shortens", () => {
    useScopeTabStore.setState({
      tabs: [tab({ id: "a", namespace: "kube-system", href: "/nodes" })],
      activeId: "a",
      pendingHref: null,
    });
    useClusterStore.setState({ currentNamespace: "kube-system" });
    mount();

    expect(tabs()[0]).toHaveAttribute(
      "aria-label",
      "k3d-dev · kube-system · nodes"
    );
  });

  it("has no native title left to cover the pickers", () => {
    useScopeTabStore.setState({
      tabs: [tab({ id: "a" })],
      activeId: "a",
      pendingHref: null,
    });
    mount();
    expect(tabs()[0]).not.toHaveAttribute("title");
  });
});

describe("a cluster the kubeconfig has lost", () => {
  beforeEach(() => {
    useScopeTabStore.setState({
      tabs: [tab({ id: "a" }), tab({ id: "b", context: "old", missing: true })],
      activeId: "a",
      pendingHref: null,
    });
  });

  it("reads as a state beside the name, not as a suffix on it", () => {
    mount();
    const gone = tabs()[1];
    expect(within(gone).getByText("old")).toBeInTheDocument();
    expect(within(gone).getByText("missing")).toBeInTheDocument();
    expect(gone.textContent).not.toContain("(missing)");
  });

  it("says so with a shape as well, not colour alone", () => {
    mount();
    const dot = tabs()[1].querySelector("span.rounded-full");
    // A ring, and no cluster colour painted into it.
    expect(dot?.className).toContain("border-fg-fnt");
    expect(dot?.getAttribute("style")).toBeNull();
  });

  it("always names the cluster it lost, whatever else the strip drops", () => {
    mount();
    expect(screen.getByText("old")).toBeInTheDocument();
  });
});

describe("a tab with no cluster", () => {
  beforeEach(() => {
    useClusterStore.setState({ currentContext: null, isConnected: false });
    useScopeTabStore.setState({
      tabs: [tab({ id: "a", context: null })],
      activeId: "a",
      pendingHref: null,
    });
  });

  it("collapses to one segment, and it is a verb", () => {
    mount();
    const strip = tabs()[0];
    expect(within(strip).getByText("Choose a cluster")).toBeInTheDocument();
    // The scope that cannot exist yet, and the page with nothing on it.
    expect(strip.textContent).not.toContain("no cluster");
    expect(strip.textContent).not.toContain("all namespaces");
    expect(strip.textContent).not.toContain("overview");
  });

  it("keeps its place, because it is where a cluster gets picked", () => {
    mount();
    expect(tabs()).toHaveLength(1);
  });

  it("offers no close on the only tab, which has nothing to fall back to", () => {
    mount();
    expect(screen.queryByLabelText("Close tab")).not.toBeInTheDocument();
  });
});
