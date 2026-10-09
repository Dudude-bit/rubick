import { beforeEach, expect, it, vi } from "vite-plus/test";
import { useRouterState } from "@tanstack/react-router";

const launch = vi.hoisted(() => ({ urls: [] as string[] }));

vi.mock("@/lib/host", () => ({
  launchLinks: vi.fn(async () => launch.urls),
  onOpenLinks: vi.fn(async () => () => {}),
}));

vi.mock("@/lib/commands", () => ({
  commands: {
    connectCluster: vi.fn(async (context: string) => ({ context })),
    disconnectCluster: vi.fn(async () => undefined),
    saveClusterPreferences: vi.fn(async () => undefined),
  },
}));

import { commands } from "@/lib/commands";
import { useScopeTabs } from "@/routes/c/$cluster/-shell/useScopeTabs";
import { useClusterStore } from "@/stores/clusterStore";
import { useScopeTabStore } from "@/stores/scopeTabStore";
import { renderWithRouter } from "@/test/render";
import { useDeepLinks } from "./useDeepLinks";

/** The shell the app mounts: links at the root, the tab bridge only inside a cluster. */
function Window() {
  useDeepLinks();
  const inCluster = useRouterState({
    select: (s) => s.location.pathname.startsWith("/c/"),
  });
  return inCluster ? <Shell /> : null;
}

function Shell() {
  useScopeTabs();
  return null;
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useClusterStore.setState({
    contexts: [{ name: "acme-staging" }, { name: "acme-prod" }] as never,
    currentContext: null,
    currentNamespace: "",
    namespaceScope: [],
    isConnected: false,
  });
  // What the session restore leaves before the first route: the last page
  // asked for, in another cluster, with its own namespaces.
  useScopeTabStore.setState({
    tabs: [
      {
        id: "a",
        context: "acme-prod",
        namespace: "team-checkout",
        scope: ["team-checkout"],
        href: "/c/acme-prod/services",
        missing: false,
      },
    ],
    activeId: "a",
    pendingHref: "/c/acme-prod/services",
    linked: false,
  });
});

/**
 * Marco started the app with a link to team-blind's Deployments; it showed
 * for an instant and the restored session put back Namespaces, then
 * Services. Fails if the restored route or its cluster and namespaces are
 * applied over the link the app was started with.
 */
it("opens the link the app was started with, not the page the session restores", async () => {
  launch.urls = [
    "rubick://open/c/acme-staging/deployments?namespace=team-blind&t=2026-10-09T03:59:40Z",
  ];
  const { router } = await renderWithRouter(<Window />, {
    at: "/",
    route: "$",
  });

  await vi.waitFor(() =>
    expect(router.state.location.pathname).toBe("/c/acme-staging/deployments")
  );
  await vi.waitFor(() =>
    expect(useScopeTabStore.getState().tabs[0]).toMatchObject({
      context: "acme-staging",
      href: expect.stringMatching(/^\/c\/acme-staging\/deployments\b/),
    })
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(router.state.location.pathname).toBe("/c/acme-staging/deployments");
  expect(useScopeTabStore.getState().pendingHref).toBeNull();
  // The link's own route connects its cluster; the restore connects nothing.
  expect(commands.connectCluster).not.toHaveBeenCalled();
  expect(useClusterStore.getState().namespaceScope).toEqual([]);
});
