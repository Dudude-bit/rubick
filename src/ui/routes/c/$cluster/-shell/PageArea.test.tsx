import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act, screen } from "@testing-library/react";
import type { ReactNode } from "react";
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
  });
});

/** The Deployments list, as it draws itself with no cluster under it. */
const deploymentsPage = () => (
  <ConnectClusterEmptyState resourceLabel="Deployments" />
);

async function mountDeployments(page?: ReactNode) {
  const root = createRootRoute({ component: Outlet });
  const cluster = createRoute({
    getParentRoute: () => root,
    path: "/c/$cluster",
    validateSearch: appSearch,
    component: () => <PageArea page={page} />,
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
  return renderWithProviders(<RouterProvider router={router} />);
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

  /**
   * The address can name a cluster the kubeconfig does not list while an
   * earlier failure still stands. Fails if that failure covers the page
   * saying the named cluster is missing.
   */
  it("keeps a page about the address over another cluster's failed connect", async () => {
    useClusterStore.setState({
      error: "Connection error: deadline has elapsed",
      errorContext: "acme-prod-eu",
    });

    await mountDeployments(<p>gone-cluster is not in the kubeconfig</p>);

    expect(
      screen.getByText("gone-cluster is not in the kubeconfig")
    ).toBeVisible();
    expect(
      screen.queryByText(t("cluster", "didNotAnswer"))
    ).not.toBeInTheDocument();
  });
});
