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
