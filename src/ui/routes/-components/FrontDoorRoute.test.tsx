import { screen } from "@testing-library/react";
import { useRouterState } from "@tanstack/react-router";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ContextInfo } from "@/generated/types";
import { useClusterStore } from "@/stores/clusterStore";
import { useScopeTabStore } from "@/stores/scopeTabStore";
import { renderWithRouter } from "@/test/render";

const door = vi.hoisted(() => ({ drawn: 0 }));

vi.mock("./ClusterFrontDoor", () => ({
  ClusterFrontDoor: () => {
    door.drawn += 1;
    return <p>Pick a cluster</p>;
  },
}));

const { FrontDoorRoute } = await import("./FrontDoorRoute");

const visited: string[] = [];

/** A cluster's page: connecting is what arriving at one does, so each one arrived at is kept. */
function ClusterPage() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  if (visited.at(-1) !== pathname) visited.push(pathname);
  return null;
}

const open = () =>
  renderWithRouter(<FrontDoorRoute />, {
    at: "/",
    route: "/",
    beside: { "/c/$cluster/$": <ClusterPage /> },
  });

beforeEach(() => {
  visited.length = 0;
  door.drawn = 0;
  useClusterStore.setState({
    contexts: [{ name: "acme-staging" } as ContextInfo],
    contextsKnown: true,
    lastContext: "acme-staging",
  });
  useScopeTabStore.setState({ pendingHref: null });
});

describe("where the window goes from the front door", () => {
  /**
   * The window boots at the door with the active tab's route still to be
   * delivered, and the bridge that delivers it is mounted with the shell.
   * Sent to the last cluster first, it connected that one and then went to
   * the tab's: a connect, and a sign-in, for a cluster the tab is not in.
   * Fails if the window passes through any cluster but the restored tab's.
   */
  it("goes straight to the route a restored tab is waiting on", async () => {
    useScopeTabStore.setState({ pendingHref: "/c/acme-old/pods" });

    const { router } = await open();

    await vi.waitFor(() =>
      expect(router.state.location.pathname).toBe("/c/acme-old/pods")
    );
    await vi.waitFor(() => expect(visited).toEqual(["/c/acme-old/pods"]));
  });

  /**
   * A kubeconfig that cannot be read is said at the door, beside the file it
   * was read from and the way to change it; the page a cluster's address
   * draws for it has neither. Fails if a restored route takes the window
   * off the door before the kubeconfig is read.
   */
  it("waits at the door while the kubeconfig is unread", async () => {
    useClusterStore.setState({ contextsKnown: false });
    useScopeTabStore.setState({ pendingHref: "/c/acme-old/pods" });

    const { router } = await open();

    expect(await screen.findByText("Pick a cluster")).toBeVisible();
    expect(router.state.location.pathname).toBe("/");
  });

  /**
   * Fails if a window with no route to restore stops going back to its last
   * cluster, or draws the picker on its way there.
   */
  it("goes to the cluster the window was last in when no tab waits on a route", async () => {
    const { router } = await open();

    await vi.waitFor(() =>
      expect(router.state.location.pathname).toBe("/c/acme-staging")
    );
    expect(door.drawn).toBe(0);
  });

  /**
   * Closing the last tab asks for the door itself. Fails if that is taken
   * for a route to restore, which leaves the window blank at the door.
   */
  it("shows the door when the door is the route asked for", async () => {
    useClusterStore.setState({ lastContext: null });
    useScopeTabStore.setState({ pendingHref: "/" });

    const { router } = await open();

    expect(await screen.findByText("Pick a cluster")).toBeVisible();
    expect(router.state.location.pathname).toBe("/");
  });
});
