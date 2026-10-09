import { act, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@/lib/commands", () => ({
  commands: { saveClusterPreferences: () => Promise.resolve() },
}));

import { renderWithRouter } from "@/test/render";
import { useClusterStore } from "@/stores/clusterStore";
import { useScopeFromAddress } from "./useScopeFromAddress";

function Shell() {
  useScopeFromAddress();
  return null;
}

const arrive = (at: string) =>
  renderWithRouter(<Shell />, { at, route: "/c/$cluster/$" });

beforeEach(() => {
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
