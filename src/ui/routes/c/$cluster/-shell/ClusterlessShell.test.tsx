import { act, fireEvent, screen, within } from "@testing-library/react";
import {
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import type { ContextInfo } from "@/generated/types";
import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import { useClusterStore } from "@/stores/clusterStore";
import { useScopeTabStore, type ScopeTab } from "@/stores/scopeTabStore";
import { renderWithRouter } from "@/test/render";

vi.mock("@/lib/commands", () => ({
  commands: new Proxy({}, { get: () => vi.fn(async () => null) }),
}));

const { ClusterRoute } = await import("../route");

const t: T = (section, key, values) => translate("en", section, key, values);

beforeAll(() => {
  Element.prototype.scrollIntoView ??= () => {};
});

const context = (name: string): ContextInfo =>
  ({
    name,
    cluster: name,
    user: `${name}-user`,
    namespace: null,
    is_current: true,
    server: `https://${name}.example:6443`,
    exec_command: null,
    auth: { kind: "token", source: null },
  }) as unknown as ContextInfo;

beforeEach(() => {
  localStorage.clear();
  useScopeTabStore.setState({
    tabs: [
      { id: "t", context: null, namespace: "", href: "/", missing: false },
    ],
    activeId: "t",
    pendingHref: null,
  });
  useClusterStore.setState({
    contexts: [context("acme-staging")],
    contextsKnown: true,
    currentContext: "acme-staging",
    isConnected: true,
    error: "Connection error: deadline has elapsed",
    errorContext: "acme-prod-eu",
  });
});

const openMissing = () =>
  renderWithRouter(<ClusterRoute />, {
    at: "/c/no-such-cluster",
    route: "/c/$cluster",
  });

describe("an address naming a cluster the kubeconfig does not list", () => {
  /** Dana's no-such-cluster page kept acme-staging's live sidebar, and its Events link renamed the tab while the page stayed the error. Fails if the connected cluster's sidebar or status bar comes back beside it. */
  it("draws no sidebar, tab or status bar of the connected cluster", async () => {
    await openMissing();
    expect(
      screen.getByText(
        t("empty", "clusterMissing", { cluster: "no-such-cluster" })
      )
    ).toBeVisible();
    expect(
      screen.queryByRole("link", { name: /Events/ })
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    expect(
      screen.queryByText(t("cluster", "didNotAnswer"))
    ).not.toBeInTheDocument();
  });

  /** Fails if the page stops offering the clusters the kubeconfig does list. */
  it("offers the clusters it can open instead", async () => {
    await openMissing();
    expect(screen.getByText("acme-staging")).toBeVisible();
  });
});

describe("a tab whose cluster left the kubeconfig", () => {
  const tab = (id: string, context: string, missing: boolean): ScopeTab => ({
    id,
    context,
    namespace: "",
    href: `/c/${context}`,
    missing,
  });
  const connect = vi.fn(async () => {});

  beforeEach(() => {
    connect.mockClear();
    useClusterStore.setState({ error: null, errorContext: null, connect });
    useScopeTabStore.setState({
      tabs: [tab("a", "acme-staging", false), tab("b", "acme-old", true)],
      activeId: "a",
      pendingHref: null,
    });
  });

  /** The window on acme-staging, then the reader clicks the tab left on acme-old. */
  async function openLostTab() {
    const view = await renderWithRouter(<ClusterRoute />, {
      at: "/c/acme-staging",
      route: "/c/$cluster",
    });
    await act(async () => {
      await useScopeTabStore.getState().activateTab("b");
    });
    await vi.waitFor(() =>
      expect(view.router.state.location.pathname).toBe("/c/acme-old")
    );
    return view;
  }

  /**
   * The page for a lost cluster drew no strip, so the other tabs, Ctrl+Tab
   * and the tab's own close were gone with it, and it blamed a link nobody
   * had opened. Fails if a tab on a lost cluster takes the strip away, draws
   * a cluster's sidebar or status bar beside its notice, or says a link led
   * here.
   */
  it("keeps the strip beside its notice, and says a tab led here", async () => {
    await openLostTab();

    expect(screen.getAllByRole("tab")).toHaveLength(2);
    expect(screen.getByText(t("empty", "clusterMissingTabBody"))).toBeVisible();
    expect(
      screen.queryByText(t("empty", "clusterMissingBody"))
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    expect(screen.queryByRole("contentinfo")).not.toBeInTheDocument();
  });

  /** Fails if the tab beside the lost one cannot be reached from its page with one click. */
  it("goes to the tab beside it on a click in the strip", async () => {
    const { router } = await openLostTab();

    fireEvent.click(screen.getAllByRole("tab")[0]);

    await vi.waitFor(() =>
      expect(router.state.location.pathname).toBe("/c/acme-staging")
    );
  });

  /**
   * At launch nothing has yet compared the restored tab with the kubeconfig,
   * and what compares them is mounted with the strip. Fails if a tab
   * restored onto a lost cluster gets the page without the strip, where it
   * is never found to be lost.
   */
  it("keeps the strip for a tab restored onto a lost cluster, and marks it lost", async () => {
    useScopeTabStore.setState({
      tabs: [tab("a", "acme-staging", false), tab("b", "acme-old", false)],
      activeId: "b",
    });
    useClusterStore.setState({ currentContext: null, isConnected: false });

    await renderWithRouter(<ClusterRoute />, {
      at: "/c/acme-old",
      route: "/c/$cluster",
    });

    expect(screen.getAllByRole("tab")).toHaveLength(2);
    await vi.waitFor(() =>
      expect(useScopeTabStore.getState().tabs[1].missing).toBe(true)
    );
  });

  /**
   * The cluster picked on the lost tab's page was the one the window had
   * been in, so it counted as asked already: the pick landed in a shell with
   * nothing connected and had to be made again. Fails if one pick does not
   * connect.
   */
  it("connects the cluster picked on its page with that one pick", async () => {
    const { router } = await openLostTab();
    connect.mockClear();

    fireEvent.click(
      within(screen.getByRole("listbox")).getByRole("option", {
        name: /acme-staging/,
      })
    );

    await vi.waitFor(() =>
      expect(router.state.location.pathname).toBe("/c/acme-staging")
    );
    await vi.waitFor(() =>
      expect(connect).toHaveBeenCalledWith("acme-staging", { keepRoute: true })
    );
  });
});
