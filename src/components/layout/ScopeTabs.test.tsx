import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

/** What the namespace picker is looking at, per test. */
const summary = vi.hoisted(() => ({
  namespaces: [] as Array<{
    name: string;
    podCount: number;
    problemCount: number;
  }>,
  podCount: 0,
  problemCount: 0,
  problemsTruncated: 0,
}));

vi.mock("@/hooks/useClusterSummary", () => ({
  useClusterSummary: () => summary,
}));

import { TooltipProvider } from "@/components/ui/tooltip";
import { SCOPE_LIMIT, scopeLabel, wireNamespace } from "@/lib/namespace-scope";
import { ScopeTabs } from "./ScopeTabs";
import { useClusterIdentityStore } from "@/stores/clusterIdentityStore";
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
  summary.namespaces = [];
  useClusterIdentityStore.setState({ marks: {} });
  useClusterStore.setState({
    contexts: [],
    currentContext: "k3d-dev",
    currentNamespace: "",
    namespaceScope: [],
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
    useClusterStore.setState({
      currentNamespace: "kube-system",
      namespaceScope: ["kube-system"],
    });
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

describe("watching several namespaces at once", () => {
  const draw = (scope: string[]) => {
    summary.namespaces = Array.from({ length: SCOPE_LIMIT + 2 }, (_, i) => ({
      name: `ns-${i}`,
      podCount: 1,
      problemCount: 0,
    }));
    // The pair the store itself keeps: `tabScope` reads a tab whose two
    // fields disagree as one an older build parked, and hands back the older
    // field — so a test that sets an impossible pair tests nothing real.
    useClusterStore.setState({
      currentNamespace: wireNamespace(scope),
      namespaceScope: scope,
    });
    useScopeTabStore.setState({
      tabs: [tab({ id: "a" })],
      activeId: "a",
      pendingHref: null,
    });
    mount();
  };

  it("names the whole selection where a reader cannot see the strip", () => {
    draw(["ns-0", "ns-1"]);
    expect(tabs()[0]).toHaveAttribute(
      "aria-label",
      "k3d-dev · ns-0, ns-1 · overview"
    );
  });

  const scope = () => useClusterStore.getState().namespaceScope;
  const rowFor = (name: string) =>
    screen.getByRole("option", { name: new RegExp(`^${name},`) });

  /** Opens the namespace list on the one tab in the strip. */
  const openPicker = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(within(tabs()[0]).getByText(scopeLabel(scope())));
    return screen.getByRole("listbox", { name: "Namespaces" });
  };

  /**
   * The frequent job, and the one every other gesture here is measured
   * against: a plain click still swaps the window onto one namespace and
   * shuts the list. Would break if adding several ever became the default.
   */
  it("replaces the selection on a plain click and shuts the list", async () => {
    const user = userEvent.setup();
    draw(["ns-0", "ns-1"]);
    await openPicker(user);

    await user.click(rowFor("ns-3"));

    expect(scope()).toEqual(["ns-3"]);
    expect(
      screen.queryByRole("listbox", { name: "Namespaces" })
    ).not.toBeInTheDocument();
  });

  /**
   * The other gesture, and the box that stands in for it. Would break if the
   * modifier or the checkbox started replacing the selection instead of
   * joining it — which is four namespaces thrown away on a gesture that asked
   * to keep them.
   */
  it("adds on a modifier click and on the box, and keeps the list open", async () => {
    const user = userEvent.setup();
    draw(["ns-0"]);
    await openPicker(user);

    await user.keyboard("{Control>}");
    await user.click(rowFor("ns-1"));
    await user.keyboard("{/Control}");
    expect(scope()).toEqual(["ns-0", "ns-1"]);

    const box = rowFor("ns-2").querySelector("[data-add]");
    await user.click(box as Element);
    expect(scope()).toEqual(["ns-0", "ns-1", "ns-2"]);

    expect(screen.getByRole("listbox", { name: "Namespaces" })).toBeVisible();
  });

  /**
   * Both gestures without a mouse, on a list that is one tab stop. Would
   * break if the rows went back to being focusable controls: an option's
   * children are presentational, so a button in one is announced as nothing
   * and a sixty-namespace cluster becomes a hundred and twenty tab presses.
   */
  it("does the same two things from the keyboard alone", async () => {
    const user = userEvent.setup();
    draw([]);
    const list = await openPicker(user);
    const filter = screen.getByRole("combobox", { name: "Filter namespaces" });

    expect(list.querySelector("button")).toBeNull();
    expect(filter).toHaveFocus();

    // Arrow onto a row: the caret stays put and the row is named instead.
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(filter).toHaveAttribute("aria-activedescendant", rowFor("ns-0").id);

    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(scope()).toEqual(["ns-0"]);
    expect(screen.getByRole("listbox", { name: "Namespaces" })).toBeVisible();

    await user.keyboard("{ArrowDown}{Enter}");
    expect(scope()).toEqual(["ns-1"]);
  });

  /**
   * The one place the ceiling is visible before it bites. Without this the
   * box that has gone quiet is a control that stopped working, and a reader
   * has no way to find out that watching a fifth namespace is a thing this
   * window will not do.
   */
  it("says how many it will watch, and says so again when it refuses", async () => {
    const user = userEvent.setup();
    draw(Array.from({ length: SCOPE_LIMIT }, (_, i) => `ns-${i}`));
    await openPicker(user);

    const ceiling = `${SCOPE_LIMIT} namespaces — the most one window reads at once.`;
    expect(screen.getByText(ceiling)).toBeInTheDocument();

    // The row that cannot be added is described by that sentence, so it is
    // spoken on arrival rather than only printed under the list.
    const spare = rowFor(`ns-${SCOPE_LIMIT}`);
    expect(
      document.getElementById(spare.getAttribute("aria-describedby") as string)
    ).toHaveTextContent(ceiling);

    await user.keyboard("{Control>}");
    await user.click(spare);
    await user.keyboard("{/Control}");

    expect(scope()).toHaveLength(SCOPE_LIMIT);
    expect(
      screen.getByText(
        `Cannot watch ns-${SCOPE_LIMIT} as well — ${SCOPE_LIMIT} namespaces is the most one window reads at once. Open it on its own instead.`
      )
    ).toBeInTheDocument();
  });

  /**
   * The ceiling is on *adding*. Would break if a full selection ever stopped
   * a reader from opening the namespace they came here for.
   */
  it("still opens a namespace on its own at the ceiling", async () => {
    const user = userEvent.setup();
    draw(Array.from({ length: SCOPE_LIMIT }, (_, i) => `ns-${i}`));
    await openPicker(user);

    await user.click(rowFor(`ns-${SCOPE_LIMIT}`));

    expect(scope()).toEqual([`ns-${SCOPE_LIMIT}`]);
  });
});

describe("a cluster that has been renamed", () => {
  beforeEach(() => {
    useClusterIdentityStore.setState({
      marks: { "k3d-dev": { alias: "payments" } },
    });
    useScopeTabStore.setState({
      tabs: [tab({ id: "a" }), tab({ id: "b", context: "prod-eu" })],
      activeId: "a",
      pendingHref: null,
    });
  });

  it("wears the name it was given where the strip names a cluster", () => {
    mount();
    expect(within(tabs()[0]).getByText("payments")).toBeInTheDocument();
    expect(within(tabs()[0]).queryByText("k3d-dev")).not.toBeInTheDocument();
  });

  it("keeps the context name in the accessible name, beside the alias", () => {
    // A reader who cannot see the strip still has to know which context is
    // about to be acted on; one who can needs the name they gave it.
    mount();
    expect(tabs()[0]).toHaveAttribute(
      "aria-label",
      "payments (k3d-dev) · all namespaces · overview"
    );
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
