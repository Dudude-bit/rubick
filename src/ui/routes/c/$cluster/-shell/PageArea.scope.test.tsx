import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import { appSearch } from "@/lib/app-search";
import { setRouter } from "@/lib/links";
import { useWindowActivity } from "@/lib/window-activity";
import { useClusterStore } from "@/stores/clusterStore";
import { useScopeTabStore } from "@/stores/scopeTabStore";
import { renderWithProviders } from "@/test/render";

const listNamespaces = vi.fn();
vi.mock("@/lib/commands", () => ({
  commands: {
    listNamespaces: () => listNamespaces(),
    saveClusterPreferences: vi.fn(async () => undefined),
  },
}));

const { PageArea } = await import("./PageArea");
const { useScopeMissing } = await import("@/hooks/useScopeMissing");

function Shell() {
  return <PageArea missing={useScopeMissing()} />;
}

const t: T = (section, key, values) => translate("en", section, key, values);

const namespace = (name: string) => ({
  name,
  status: "Active",
  createdAt: null,
  labels: {},
  annotations: {},
});

/** What an Events page draws over a scope that read back empty. */
const QUIET = "Nothing happened in this scope in the last hour.";

async function mountAt(path: string) {
  const root = createRootRoute({ component: Outlet });
  const cluster = createRoute({
    getParentRoute: () => root,
    path: "/c/$cluster",
    validateSearch: appSearch,
    component: Shell,
  });
  const events = createRoute({
    getParentRoute: () => cluster,
    path: "events",
    component: () => <p>{QUIET}</p>,
  });
  const nodes = createRoute({
    getParentRoute: () => cluster,
    path: "nodes",
    component: () => <p>2 Nodes</p>,
  });
  const router = createRouter({
    routeTree: root.addChildren([cluster.addChildren([events, nodes])]),
    history: createMemoryHistory({ initialEntries: [path] }),
    defaultPendingMinMs: 0,
  });
  setRouter(router);
  await act(() => router.load());
  renderWithProviders(<RouterProvider router={router} />);
  return router;
}

const missingTitle = t("cluster", "scopeMissingTitle", { n: 1, names: "lena" });

beforeEach(() => {
  listNamespaces.mockReset();
  listNamespaces.mockResolvedValue([
    namespace("lena-sandbox"),
    namespace("default"),
  ]);
  useScopeTabStore.setState({ pendingHref: null });
  useWindowActivity.setState({ visible: true, focused: true });
  useClusterStore.setState({
    currentContext: "acme-staging",
    isConnected: true,
    isLoading: false,
    isAuthenticating: false,
    pendingContext: null,
    error: null,
    errorContext: null,
    namespaceScope: ["lena"],
    currentNamespace: "lena",
  });
});

describe("a scope naming a namespace the cluster does not have", () => {
  /**
   * Lena typed "lena": every page read back empty and said nothing had
   * happened, a quiet namespace where there is none. Fails if a page that
   * reads the scope draws its empty answer for a namespace the cluster's
   * list does not have.
   */
  it("stands in for a page that reads the scope, and says the namespace is not there", async () => {
    await mountAt("/c/acme-staging/events");

    expect(await screen.findByText(missingTitle)).toBeVisible();
    expect(screen.queryByText(QUIET)).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: t("action", "chooseNamespace") })
    ).toBeVisible();
  });

  /** Fails if the near name stops being offered, or taking it leaves the missing one in the scope. */
  it("offers the namespace the reader most likely meant", async () => {
    await mountAt("/c/acme-staging/events");

    fireEvent.click(
      await screen.findByRole("button", { name: "lena-sandbox" })
    );
    await waitFor(() =>
      expect(useClusterStore.getState().namespaceScope).toEqual([
        "lena-sandbox",
      ])
    );
    expect(await screen.findByText(QUIET)).toBeVisible();
  });

  /** A page that does not read the scope still draws, under a line saying what the scope names. */
  it("says so above a page the scope does not touch", async () => {
    await mountAt("/c/acme-staging/nodes");

    expect(await screen.findByTestId("scope-missing")).toHaveTextContent(
      "There is no namespace named lena in this cluster"
    );
    expect(screen.getByText("2 Nodes")).toBeVisible();
  });

  /** Fails if the namespaces that are there stop being drawn because one beside them is not. */
  it("keeps the page for the namespaces that exist and names the one that does not", async () => {
    useClusterStore.setState({
      namespaceScope: ["lena-sandbox", "lena"],
      currentNamespace: "",
    });
    await mountAt("/c/acme-staging/events");

    expect(await screen.findByTestId("scope-missing")).toHaveTextContent(
      "There is no namespace named lena in this cluster"
    );
    expect(screen.getByText(QUIET)).toBeVisible();
  });

  /** A namespace made after the cached list was read is not called missing on that list's word. */
  it("asks the cluster again before calling a namespace missing", async () => {
    listNamespaces
      .mockResolvedValueOnce([namespace("default")])
      .mockResolvedValue([namespace("default"), namespace("lena")]);
    await mountAt("/c/acme-staging/events");

    await waitFor(() => expect(listNamespaces).toHaveBeenCalledTimes(3));
    expect(await screen.findByText(QUIET)).toBeVisible();
    expect(screen.queryByText(missingTitle)).not.toBeInTheDocument();
  });
});
