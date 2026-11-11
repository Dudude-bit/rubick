import { describe, expect, it, vi } from "vite-plus/test";
import { act, screen, waitFor } from "@testing-library/react";

import { renderWithProviders } from "@/test/render";

const checkAccess = vi.fn();
vi.mock("@/lib/commands", () => ({
  commands: { checkAccess: (...args: unknown[]) => checkAccess(...args) },
}));

const { useDenied } = await import("@/lib/access");
const { credentialsRenewed } = await import("@/lib/credentials");
const { forgetRefusals } = await import("@/lib/refusals");
const { useClusterStore } = await import("@/stores/clusterStore");

function Delete() {
  const denied = useDenied({ group: "", resource: "pods", namespace: "shop" });
  return <p>{denied.delete ?? "allowed"}</p>;
}

describe("a refused action asked again", () => {
  /**
   * Read again drops every kept refusal; a review cached forever is never
   * asked again, and the still refused Delete loses its mark.
   */
  it("keeps a refusal the authorizer repeats after the reader asks again", async () => {
    useClusterStore.setState({ isConnected: true, currentContext: "prod" });
    checkAccess.mockResolvedValue([{ allowed: false }, { allowed: false }]);
    renderWithProviders(<Delete />);
    expect(await screen.findByText(/delete pods -n shop/)).toBeVisible();
    act(() => forgetRefusals());
    await waitFor(() => expect(checkAccess).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/delete pods -n shop/)).toBeVisible();
  });

  /**
   * The review is asked once per connection, so a Delete the old groups were
   * refused kept its mark under credentials that may. Fails if a renewal
   * does not ask the authorizer again.
   */
  it("loses its mark when renewed credentials are allowed it", async () => {
    useClusterStore.setState({ isConnected: true, currentContext: "prod" });
    checkAccess.mockReset();
    checkAccess.mockResolvedValue([{ allowed: false }, { allowed: false }]);
    renderWithProviders(<Delete />);
    expect(await screen.findByText(/delete pods -n shop/)).toBeVisible();
    checkAccess.mockResolvedValue([{ allowed: true }, { allowed: true }]);
    act(() => credentialsRenewed());
    expect(await screen.findByText("allowed")).toBeVisible();
  });
});
