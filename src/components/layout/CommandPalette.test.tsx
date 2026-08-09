import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

vi.mock("@/lib/commands", () => ({
  commands: {
    getRecentItems: vi.fn(async () => []),
    addRecentItem: vi.fn(async () => undefined),
    saveClusterPreferences: vi.fn(async () => undefined),
  },
}));

const search = vi.hoisted(() => ({
  hits: [] as {
    context: string;
    kind: string;
    name: string;
    namespace: string | null;
  }[],
}));

vi.mock("@/hooks/useResourceSearch", () => ({
  MIN_SEARCH_LENGTH: 2,
  useResourceSearch: () => ({
    hits: search.hits,
    clusters: [
      {
        context: "k3d-dev",
        status: "done",
        reason: null,
        message: null,
        matched: search.hits.length,
        truncated: false,
      },
    ],
    isSearching: false,
    error: null,
  }),
}));

import { CommandPalette } from "./CommandPalette";
import { useClusterStore } from "@/stores/clusterStore";
import { useScopeTabStore } from "@/stores/scopeTabStore";

const hit = (over: Partial<(typeof search.hits)[number]> = {}) => ({
  context: "k3d-dev",
  kind: "Pod",
  name: "burst-demo",
  namespace: "k8s-gui-test",
  ...over,
});

async function open(query: string) {
  render(
    <MemoryRouter>
      <CommandPalette />
    </MemoryRouter>
  );
  window.dispatchEvent(new Event("command-palette-open"));
  await userEvent.type(await screen.findByRole("combobox"), query);
}

/**
 * The palette used to build a detail URL for every hit it was handed. A kind
 * the router serves no detail route for — a Namespace — then produced a path
 * that matches no branch inside the layout route, and choosing it blanked the
 * whole shell. A namespace is not a page here; it is the scope pages are read
 * under, which is what the row has to offer instead.
 */
describe("the command palette's hits", () => {
  beforeEach(() => {
    search.hits = [];
    useClusterStore.setState({
      currentContext: "k3d-dev",
      currentNamespace: "",
      isConnected: true,
    });
    useScopeTabStore.setState({
      tabs: [
        {
          id: "palette",
          context: "k3d-dev",
          namespace: "",
          href: "/",
          missing: false,
        },
      ],
      activeId: "palette",
      pendingHref: null,
    });
  });

  it("points the window at a namespace instead of opening a page for it", async () => {
    search.hits = [
      hit({ kind: "Namespace", name: "kube-system", namespace: null }),
    ];
    await open("kube-system");
    await userEvent.click(await screen.findByText("scope to it"));
    expect(useClusterStore.getState().currentNamespace).toBe("kube-system");
    // No second window's worth of tab, and nowhere new: the reader keeps the
    // page they were on, now read under that scope.
    expect(useScopeTabStore.getState().tabs).toHaveLength(1);
  });

  it("opens a namespace in a tab already scoped to it", async () => {
    search.hits = [
      hit({ kind: "Namespace", name: "kube-system", namespace: null }),
    ];
    await open("kube-system");
    fireEvent.click(await screen.findByText("scope to it"), { ctrlKey: true });
    const { tabs, activeId } = useScopeTabStore.getState();
    expect(tabs).toHaveLength(2);
    expect(tabs[1]).toMatchObject({ namespace: "kube-system" });
    expect(activeId).toBe("palette");
    expect(useClusterStore.getState().currentNamespace).toBe("");
  });

  it("does not offer a kind the router has no page for at all", async () => {
    search.hits = [
      hit({ kind: "Event", name: "burst-demo.17f", namespace: "k8s-gui-test" }),
    ];
    await open("burst-demo");
    expect(screen.queryByText(/burst-demo\.17f/)).toBeNull();
    expect(await screen.findByText(/Nothing matches/)).toBeInTheDocument();
  });

  it("still opens the kinds it does have a page for", async () => {
    search.hits = [hit()];
    await open("burst-demo");
    expect(await screen.findByText(/burst-demo/)).toBeInTheDocument();
  });
});
