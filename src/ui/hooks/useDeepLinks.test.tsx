import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
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
import { onOpenLinks } from "@/lib/host";
import { useDeepLinkStore } from "@/stores/deepLinkStore";
import { useKeptShellStore } from "@/stores/keptShellStore";
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

describe("a link that arrives while the app is open", () => {
  const POD_PAGE = "/c/acme-staging/pods/shop/cart-4f68h";
  let opened: ((urls: string[]) => void) | null = null;

  beforeEach(() => {
    launch.urls = [];
    vi.mocked(onOpenLinks).mockImplementation(async (handler) => {
      opened = handler;
      return () => {};
    });
    useClusterStore.setState({
      currentContext: "acme-staging",
      isConnected: true,
    });
    useScopeTabStore.setState({
      tabs: [
        {
          id: "a",
          context: "acme-staging",
          namespace: "",
          scope: [],
          href: POD_PAGE,
          missing: false,
        },
      ],
      activeId: "a",
      pendingHref: null,
      linked: false,
    });
    useKeptShellStore.setState({ shells: [] });
    useDeepLinkStore.setState({ arrival: null });
  });

  const link =
    "rubick://open/c/acme-staging/deployments?namespace=shop&t=2026-10-09T08:29:19Z";

  /**
   * Dana's link replaced the tab her shell was in, and the shell went with
   * it. Fails if the link navigates a tab that keeps a shell, or the new tab
   * never lands and announces the link.
   */
  it("opens in a tab of its own when the tab on screen keeps a shell", async () => {
    useKeptShellStore.getState().keep({
      id: "term-1",
      tab: "a",
      context: "acme-staging",
      namespace: "shop",
      pod: "cart-4f68h",
      container: "app",
    });
    const { router } = await renderWithRouter(<Window />, {
      at: POD_PAGE,
      route: "$",
    });
    await vi.waitFor(() => expect(opened).not.toBeNull());

    opened!([link]);

    await vi.waitFor(() =>
      expect(router.state.location.pathname).toBe("/c/acme-staging/deployments")
    );
    const { tabs, activeId } = useScopeTabStore.getState();
    expect(tabs).toHaveLength(2);
    expect(tabs[0]).toMatchObject({ id: "a", href: POD_PAGE });
    expect(activeId).toBe(tabs[1].id);
    await vi.waitFor(() =>
      expect(useDeepLinkStore.getState().arrival?.status).toBe("live")
    );
  });

  /** Fails if a link opens a new tab where nothing would be lost by staying. */
  it("takes the tab on screen when it keeps no shell", async () => {
    const { router } = await renderWithRouter(<Window />, {
      at: POD_PAGE,
      route: "$",
    });
    await vi.waitFor(() => expect(opened).not.toBeNull());

    opened!([link]);

    await vi.waitFor(() =>
      expect(router.state.location.pathname).toBe("/c/acme-staging/deployments")
    );
    expect(useScopeTabStore.getState().tabs).toHaveLength(1);
  });
});
