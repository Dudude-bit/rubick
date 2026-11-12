import { describe, expect, it, vi } from "vite-plus/test";
import { focusManager } from "@tanstack/react-query";
import { act, screen, waitFor } from "@testing-library/react";

import { renderWithProviders } from "@/test/render";

const checkAccess = vi.fn();
vi.mock("@/lib/commands", () => ({
  commands: { checkAccess: (...args: unknown[]) => checkAccess(...args) },
}));

const { useDenied, useNodeDebugDenied, usePodDenied } =
  await import("@/lib/access");
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

describe("a refused action through a credential renewal", () => {
  /**
   * A renewal emptied the refusal memory, and Delete read as allowed for
   * the second its review took to answer again. Fails if the mark goes out
   * while the review is asked again, stays after the review allows it, or
   * outlives a review the cluster does not answer.
   */
  it("keeps its mark until the review answers again, and no longer", async () => {
    useClusterStore.setState({ isConnected: true, currentContext: "prod" });
    checkAccess.mockReset();
    checkAccess.mockResolvedValue([{ allowed: false }, { allowed: false }]);
    renderWithProviders(<Delete />);
    expect(await screen.findByText(/delete pods -n shop/)).toBeVisible();

    let answer: (allowed: { allowed: boolean }[]) => void = () => {};
    checkAccess.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      })
    );
    act(() => credentialsRenewed());
    await waitFor(() => expect(checkAccess).toHaveBeenCalledTimes(2));
    expect(screen.getByText(/delete pods -n shop/)).toBeVisible();
    await act(async () => answer([{ allowed: true }, { allowed: true }]));
    expect(await screen.findByText("allowed")).toBeVisible();

    checkAccess.mockResolvedValue([{ allowed: false }, { allowed: false }]);
    act(() => credentialsRenewed());
    expect(await screen.findByText(/delete pods -n shop/)).toBeVisible();
    checkAccess.mockRejectedValue(new Error("the cluster did not answer"));
    act(() => credentialsRenewed());
    expect(await screen.findByText("allowed")).toBeVisible();
  });
});

describe("how often the access review is asked", () => {
  /** Long enough for a retry or a refetch that was going to happen to have asked. */
  const settled = () =>
    act(() => new Promise<void>((resolve) => setTimeout(resolve, 30)));

  /**
   * Once per connection is the whole budget, answered or not: every greyed
   * button on screen asks it. Fails if a review the cluster did not answer is
   * retried, or asked again each time the window takes focus.
   */
  it("asks a review that could not be asked once, not again on focus", async () => {
    useClusterStore.setState({ isConnected: true, currentContext: "prod" });
    checkAccess.mockReset();
    checkAccess.mockRejectedValue(new Error("the cluster did not answer"));
    renderWithProviders(<Delete />);
    await waitFor(() => expect(checkAccess).toHaveBeenCalledTimes(1));
    await settled();

    act(() => focusManager.setFocused(false));
    act(() => focusManager.setFocused(true));
    await settled();
    focusManager.setFocused(undefined);

    expect(checkAccess).toHaveBeenCalledTimes(1);
    expect(screen.getByText("allowed")).toBeVisible();
  });

  /**
   * Fails if a surface with no action to ask about sends the authorizer an
   * empty review, or one is sent before the cluster is connected.
   */
  it("asks nothing with nothing to ask, or with no cluster connected", async () => {
    checkAccess.mockReset();
    checkAccess.mockResolvedValue([]);
    function Nothing() {
      useDenied(null);
      return null;
    }
    useClusterStore.setState({ isConnected: true, currentContext: "prod" });
    const connected = renderWithProviders(<Nothing />);
    await settled();
    connected.unmount();

    useClusterStore.setState({ isConnected: false, currentContext: "prod" });
    renderWithProviders(<Delete />);
    await settled();

    expect(checkAccess).not.toHaveBeenCalled();
  });
});

describe("a session that reaches the cluster through kubectl proxy", () => {
  function Ways() {
    const pod = usePodDenied("shop", "web-1");
    const node = useNodeDebugDenied("shop");
    return (
      <ul>
        {Object.entries({ ...pod, portForward: pod.portForward, node }).map(
          ([way, why]) => (
            <li key={way}>{`${way}: ${why ?? "open"}`}</li>
          )
        )}
      </ul>
    );
  }
  const allowsAll = () =>
    checkAccess.mockImplementation(async (asked: unknown[]) =>
      asked.map(() => ({ allowed: true }))
    );

  /**
   * kubectl proxy answers every exec and attach with a bare 403 by its
   * default filter, so Shell, Files, Checks and Debug all failed there as
   * if RBAC had refused them, with the authorizer saying yes. Fails if a
   * way that needs an exec reads as open in such a session, or a port
   * forward, which the proxy passes, reads as shut.
   */
  it("says every way into a container is shut, and why, though the authorizer allows them", async () => {
    checkAccess.mockReset();
    allowsAll();
    useClusterStore.setState({
      isConnected: true,
      currentContext: "prod",
      connectedThrough: "kubectl_proxy",
    });
    renderWithProviders(<Ways />);
    for (const way of ["shell", "ephemeral", "copy", "debug", "node"])
      expect(
        screen.getByText(new RegExp(`^${way}: Not available in this session`))
      ).toHaveTextContent("kubectl proxy, which refuses every exec and attach");
    expect(screen.getByText("portForward: open")).toBeVisible();
  });

  /** The other side: a direct session says nothing of a proxy. */
  it("leaves a direct session's ways open", async () => {
    checkAccess.mockReset();
    allowsAll();
    useClusterStore.setState({
      isConnected: true,
      currentContext: "prod",
      connectedThrough: "direct",
    });
    renderWithProviders(<Ways />);
    for (const way of ["shell", "ephemeral", "copy", "debug", "node"])
      expect(screen.getByText(`${way}: open`)).toBeVisible();
  });
});
