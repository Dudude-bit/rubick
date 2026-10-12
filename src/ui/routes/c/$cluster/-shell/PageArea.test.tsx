import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act, screen } from "@testing-library/react";
import {
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import { ConnectClusterEmptyState } from "@/components/ui/connect-cluster-empty-state";
import type { ContextInfo } from "@/generated/types";
import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import { appSearch } from "@/lib/app-search";
import { setRouter } from "@/lib/links";
import { useClusterStore } from "@/stores/clusterStore";
import { useScopeTabStore } from "@/stores/scopeTabStore";
import { renderWithProviders } from "@/test/render";

vi.mock("@/lib/commands", () => ({
  commands: {
    getKubeconfigPath: vi.fn(async () => null),
    getKubeconfigPaths: vi.fn(async () => []),
    getKubeconfigSource: vi.fn(async () => ({
      candidates: [
        { path: "/home/dana/.kube/config", exists: true, origin: "unset" },
      ],
      counts: null,
      error: null,
    })),
    connectionAttempt: vi.fn(async () => ({
      context: "acme-prod-eu",
      at: "2026-10-05T17:31:17Z",
      direct: {
        state: "failed",
        error: "Connection error: deadline has elapsed",
        failure: "timeout",
      },
      proxy: { state: "notTried" },
    })),
  },
}));

const { PageArea } = await import("./PageArea");

const t: T = (section, key, values) => translate("en", section, key, values);

beforeAll(() => {
  Element.prototype.scrollIntoView ??= () => {};
});

const context = (name: string, server: string): ContextInfo =>
  ({
    name,
    cluster: name,
    user: `${name}-user`,
    namespace: null,
    is_current: false,
    server,
    exec_command: null,
    auth: { kind: "token", source: null },
  }) as unknown as ContextInfo;

beforeEach(() => {
  localStorage.clear();
  useScopeTabStore.setState({ pendingHref: null });
  useClusterStore.setState({
    contexts: [
      context("acme-prod-eu", "https://10.255.255.1:6443"),
      context("acme-staging", "https://staging.example:6443"),
    ],
    contextsKnown: true,
    currentContext: "acme-prod-eu",
    isConnected: false,
    isLoading: false,
    isAuthenticating: false,
    pendingContext: null,
    connectStartedAt: null,
    error: null,
    errorContext: null,
    live: [],
    wayBack: null,
  });
});

/** The Deployments list, as it draws itself with no cluster under it. */
const deploymentsPage = () => (
  <ConnectClusterEmptyState resourceLabel="Deployments" />
);

async function mountDeployments() {
  const root = createRootRoute({ component: Outlet });
  const cluster = createRoute({
    getParentRoute: () => root,
    path: "/c/$cluster",
    validateSearch: appSearch,
    component: () => <PageArea />,
  });
  const deployments = createRoute({
    getParentRoute: () => cluster,
    path: "deployments",
    component: deploymentsPage,
  });
  const router = createRouter({
    routeTree: root.addChildren([cluster.addChildren([deployments])]),
    history: createMemoryHistory({
      initialEntries: ["/c/acme-prod-eu/deployments"],
    }),
    defaultPendingMinMs: 0,
  });
  setRouter(router);
  await act(() => router.load());
  renderWithProviders(<RouterProvider router={router} />);
  return router;
}

describe("a page under a cluster that is not connected yet", () => {
  /**
   * Dana's Deployments page said "No cluster is connected" over a connect
   * that had timed out, while only the Overview named the failure. Fails if
   * the layout stops standing in for the page, or if the failed screen loses
   * the kind line or the way back to another context.
   */
  it("leads with the kind of failure when the connect failed, not with no cluster connected", async () => {
    useClusterStore.setState({
      error:
        "Connection error: Failed to get server version: ServiceError: client error (Connect): deadline has elapsed",
      errorContext: "acme-prod-eu",
    });

    await mountDeployments();

    expect(
      await screen.findByText(
        t("cluster", "failTimeout", {
          host: "10.255.255.1:6443",
          context: "acme-prod-eu",
        })
      )
    ).toBeVisible();
    expect(screen.getByText(t("cluster", "didNotAnswer"))).toBeVisible();
    expect(
      screen.getByRole("button", { name: t("action", "retry") })
    ).toBeVisible();
    expect(screen.getByText(t("action", "details"))).toBeVisible();
    expect(screen.getByText("acme-staging")).toBeVisible();
    expect(
      screen.queryByText(t("empty", "noClusterIsConnected"))
    ).not.toBeInTheDocument();
  });

  /**
   * The minute a timeout takes was spent on "No cluster is connected", with
   * no Cancel and no clock. Fails if the connecting screen is the Overview's
   * alone again.
   */
  it("shows the connect in flight with its Cancel while it waits", async () => {
    useClusterStore.setState({
      isAuthenticating: true,
      pendingContext: "acme-prod-eu",
      connectStartedAt: Date.now(),
    });

    await mountDeployments();

    expect(
      screen.getByText(
        t("cluster", "connectingTo", { context: "acme-prod-eu" })
      )
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: t("action", "cancel") })
    ).toBeVisible();
    expect(
      screen.queryByText(t("empty", "noClusterIsConnected"))
    ).not.toBeInTheDocument();
  });

  /** Fails if the stand-in covers a page when there is no connect to talk about. */
  it("leaves the page to say it has no cluster once nothing is connecting or failed", async () => {
    await mountDeployments();

    expect(screen.getByText(t("empty", "noClusterIsConnected"))).toBeVisible();
    expect(
      screen.queryByText(t("cluster", "didNotAnswer"))
    ).not.toBeInTheDocument();
  });
});

describe("a switch to a cluster that did not answer", () => {
  const failedFromStaging = (live: string[]) =>
    useClusterStore.setState({
      error: "Connection error: deadline has elapsed",
      errorContext: "acme-prod-eu",
      wayBack: "acme-staging",
      live,
    });

  /**
   * Live round 23: the switch left Dana nowhere. The cluster she came from
   * is still connected, so the failed page offers it back, marked live.
   * Fails if the way back is missing or does not take her there.
   */
  it("offers the cluster it left, still connected, and takes the reader back to it", async () => {
    failedFromStaging(["acme-staging"]);
    const router = await mountDeployments();

    const back = await screen.findByRole("button", {
      name: t("cluster", "backToConnected", { context: "acme-staging" }),
    });
    expect(back.querySelector("svg")?.getAttribute("class")).toContain(
      "text-ok"
    );
    await act(async () => back.click());

    expect(router.state.location.pathname).toBe("/c/acme-staging/deployments");
  });

  /** Fails if the way back is offered for a cluster nothing still holds. */
  it("offers no way back once the cluster it left is no longer connected", async () => {
    failedFromStaging([]);
    await mountDeployments();

    await screen.findByRole("button", { name: t("action", "retry") });
    expect(
      screen.queryByRole("button", {
        name: t("cluster", "backToConnected", { context: "acme-staging" }),
      })
    ).toBeNull();
  });

  /**
   * Cancelling a switch is not leaving: the cluster it started from is still
   * connected, so Cancel goes back there rather than to the front door.
   * Fails if Cancel disconnects while there is somewhere to go back to.
   */
  it("cancels a switch back to the cluster it left", async () => {
    useClusterStore.setState({
      isAuthenticating: true,
      pendingContext: "acme-prod-eu",
      connectStartedAt: Date.now(),
      wayBack: "acme-staging",
      live: ["acme-staging"],
    });
    const router = await mountDeployments();

    await act(async () =>
      screen.getByRole("button", { name: t("action", "cancel") }).click()
    );

    expect(router.state.location.pathname).toBe("/c/acme-staging/deployments");
  });

  /**
   * Coming back to a held cluster takes no connecting screen, and for that
   * beat the cache is still the cluster just left. Fails if the page draws
   * over it.
   */
  it("draws no page while a held cluster is coming back", async () => {
    useClusterStore.setState({ pendingContext: "acme-prod-eu" });

    await mountDeployments();

    expect(
      screen.queryByText(t("empty", "noClusterIsConnected"))
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(
        t("cluster", "connectingTo", { context: "acme-prod-eu" })
      )
    ).not.toBeInTheDocument();
  });
});
