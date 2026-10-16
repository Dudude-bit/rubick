import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";

const scaleDeployment = vi.hoisted(() => vi.fn(async () => undefined));
const restartDeployment = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/lib/commands", async (original) => {
  const real = await original<typeof import("@/lib/commands")>();
  return {
    commands: { ...real.commands, scaleDeployment, restartDeployment },
  };
});

import { useClusterStore } from "@/stores/clusterStore";
import { useTellMeWhenStore } from "@/stores/tellMeWhenStore";
import { renderWithRouter } from "@/test/render";
import { PeekActions } from "../-peek/PeekActions";

const CART = {
  name: "cart",
  namespace: "shop",
  generation: 1,
  replicas: { desired: 2, ready: 2, available: 2, updated: 2 },
};

const peek = () =>
  renderWithRouter(
    <PeekActions
      target={{ kind: "Deployment", name: "cart", namespace: "shop" }}
      detail={CART}
      onClose={vi.fn()}
    />
  );

const open = () =>
  useTellMeWhenStore
    .getState()
    .watches.filter((watch) => watch.status.state === "watching");

beforeEach(() => {
  useTellMeWhenStore.setState({ watches: [] });
  useClusterStore.setState({
    currentContext: "acme-staging",
    isConnected: true,
  });
});

describe("what a Deployment's actions leave watching", () => {
  /**
   * Dana scaled cart 2 to 3 from its peek and was told "cart rolled out, 3
   * of 3 ready, revision 1", and the peek offered Stop watching: a scale had
   * armed a rollout watch. Fails if a scale arms one.
   */
  it("arms nothing on a plain scale", async () => {
    await peek();
    fireEvent.click(screen.getByRole("button", { name: "Scale" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/replicas/i), {
      target: { value: "3" },
    });
    fireEvent.submit(
      within(dialog)
        .getByLabelText(/replicas/i)
        .closest("form")!
    );

    await waitFor(() =>
      expect(scaleDeployment).toHaveBeenCalledWith("cart", 3, "shop")
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(open()).toEqual([]);
    expect(screen.queryByText("Stop watching")).toBeNull();
  });

  /** And a restart, which is a rollout, still does: the check above is not blind. */
  it("still follows a restart", async () => {
    await peek();
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Restart" }));

    await waitFor(() => expect(restartDeployment).toHaveBeenCalled());
    await waitFor(() => expect(open()).toHaveLength(1));
    expect(open()[0].after?.action).toBe("restart");
  });
});

describe("the restart dialog of a workload whose pods are failing", () => {
  const restartOf = async (ready: number) => {
    await renderWithRouter(
      <PeekActions
        target={{ kind: "Deployment", name: "checkout", namespace: "shop" }}
        detail={{
          ...CART,
          name: "checkout",
          replicas: { desired: 2, ready, available: ready, updated: 2 },
        }}
        onClose={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    return screen.findByRole("dialog");
  };

  /**
   * Dana's checkout had 0 of 2 pods ready and the dialog only said how the
   * restart would roll, as if restarting were the cure. Fails if a restart
   * of failing pods is asked without saying they are failing and where to
   * see why.
   */
  it("says how many pods are ready and points at why before restarting", async () => {
    const dialog = await restartOf(0);
    expect(
      within(dialog).getByText(/Not every pod is ready: 0 of 2/)
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("link", { name: "See why on the Pods tab." })
    ).toHaveAttribute(
      "href",
      expect.stringMatching(/\/deployments\/shop\/checkout\?tab=pods$/)
    );
  });

  /** Fails if the warning is drawn over a workload whose pods are all ready. */
  it("says nothing of the kind when every pod is ready", async () => {
    const dialog = await restartOf(2);
    expect(within(dialog).queryByText(/Not every pod is ready/)).toBeNull();
  });
});
