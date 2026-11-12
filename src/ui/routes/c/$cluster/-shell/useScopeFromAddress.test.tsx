import { act, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@/lib/commands", () => ({
  commands: { saveClusterPreferences: () => Promise.resolve() },
}));

import { renderWithRouter, settle } from "@/test/render";
import { useClusterStore } from "@/stores/clusterStore";
import { useScopeTabStore } from "@/stores/scopeTabStore";
import { useScopeFromAddress } from "./useScopeFromAddress";

function Shell() {
  useScopeFromAddress();
  return null;
}

const arrive = (at: string) =>
  renderWithRouter(<Shell />, { at, route: "/c/$cluster/$" });

beforeEach(() => {
  useScopeTabStore.setState({ activeId: "a", pendingHref: null });
  useClusterStore.setState({
    currentContext: "acme-staging",
    isConnected: true,
    namespaceScope: ["team-checkout"],
    currentNamespace: "team-checkout",
  });
});

describe("a namespace named in the address", () => {
  /**
   * A link to a list in one namespace is only that if the window reads that
   * namespace. Fails if the scope is not moved, or the key stays in the
   * address to pin the scope against the reader's next choice.
   */
  it("scopes the window to it and leaves the address", async () => {
    const { router } = await arrive(
      "/c/acme-staging/deployments?namespace=team-blind"
    );

    await waitFor(() =>
      expect(useClusterStore.getState().namespaceScope).toEqual(["team-blind"])
    );
    await waitFor(() => expect(router.state.location.search).toEqual({}));
    expect(router.state.location.pathname).toBe("/c/acme-staging/deployments");
  });

  /** Fails if a link into another cluster rescopes the one still connected. */
  it("waits for its own cluster to be the one connected", async () => {
    useClusterStore.setState({ currentContext: "prod" });
    const { router } = await arrive(
      "/c/acme-staging/deployments?namespace=team-blind"
    );
    expect(useClusterStore.getState().namespaceScope).toEqual([
      "team-checkout",
    ]);

    act(() => useClusterStore.setState({ currentContext: "acme-staging" }));
    await waitFor(() =>
      expect(useClusterStore.getState().namespaceScope).toEqual(["team-blind"])
    );
    await waitFor(() => expect(router.state.location.search).toEqual({}));
  });
});

describe("an address showing one object", () => {
  const scope = () => useClusterStore.getState().namespaceScope;

  /**
   * Lena's tab read "shop / wd-demo" over a pod in lena-sandbox. Fails if
   * arriving at an object outside the scope leaves the scope where it was.
   */
  it("moves a scope that does not hold the object to its namespace", async () => {
    await arrive("/c/acme-staging/pods/lena-sandbox/wd-demo");
    await waitFor(() => expect(scope()).toEqual(["lena-sandbox"]));
  });

  /**
   * Dana's tab read "lena-sandbox / team-checkout" on the team-checkout
   * namespace page. Fails if a Namespace's own page is not in that namespace.
   */
  it("reads a Namespace's own page as being in that namespace", async () => {
    await arrive("/c/acme-staging/namespaces/shop");
    await waitFor(() => expect(scope()).toEqual(["shop"]));
  });

  /** Fails if all namespaces, or a selection already holding it, is narrowed. */
  it.each([[[]], [["lena-sandbox", "team-checkout"]]])(
    "leaves a scope that already holds it (%j)",
    async (held: string[]) => {
      useClusterStore.setState({ namespaceScope: held });
      const { router } = await arrive(
        "/c/acme-staging/pods/lena-sandbox/wd-demo"
      );
      await settle(router);
      expect(scope()).toEqual(held);
    }
  );

  /** Fails if a list or a cluster-scoped object moves the scope. */
  it.each([
    "/c/acme-staging/pods",
    "/c/acme-staging/nodes/agent-0",
    "/c/acme-staging/namespaces",
  ])("leaves the scope alone on %s", async (at) => {
    const { router } = await arrive(at);
    await settle(router);
    expect(scope()).toEqual(["team-checkout"]);
  });

  /**
   * The reader may pick another scope while the object is on screen. Fails if
   * the arrival is applied again over that choice.
   */
  it("moves the scope once per arrival, not against the reader's next pick", async () => {
    await arrive("/c/acme-staging/pods/lena-sandbox/wd-demo");
    await waitFor(() => expect(scope()).toEqual(["lena-sandbox"]));

    await act(() => useClusterStore.getState().setNamespaceScope(["shop"]));
    act(() => useClusterStore.setState({ isConnected: false }));
    act(() => useClusterStore.setState({ isConnected: true }));
    expect(scope()).toEqual(["shop"]);
  });

  /**
   * Mid-switch the address is still the tab being left. Fails if its object
   * rescopes the tab being opened.
   */
  it("waits for a tab switch to land before reading the address", async () => {
    useScopeTabStore.setState({ pendingHref: "/c/acme-staging/pods" });
    const { router } = await arrive(
      "/c/acme-staging/pods/lena-sandbox/wd-demo"
    );
    await settle(router);
    expect(scope()).toEqual(["team-checkout"]);

    act(() => useScopeTabStore.setState({ pendingHref: null }));
    await waitFor(() => expect(scope()).toEqual(["lena-sandbox"]));
  });
});
