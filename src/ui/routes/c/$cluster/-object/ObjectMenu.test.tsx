import { beforeEach, describe, expect, it } from "vite-plus/test";
import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { PodInfo } from "@/generated/types";
import { ResourceRef } from "@/components/object/ResourceRef";
import { useClusterStore } from "@/stores/clusterStore";
import { renderWithRouter } from "@/test/render";
import { ObjectMenu } from "./ObjectMenu";
import { PodListCard } from "./PodListCard";

const POD = {
  name: "cart-6dc786ff6d-rh8q5",
  namespace: "shop",
  uid: "pod-uid",
  status: { phase: "Running", display: "Running", ready: true, conditions: [] },
  nodeName: "node01",
  containers: [],
  initContainers: [],
  restartCount: 0,
  createdAt: null,
} as unknown as PodInfo;

beforeEach(() => {
  useClusterStore.setState({ currentContext: "prod", isConnected: true });
});

const draw = () =>
  renderWithRouter(
    <>
      <PodListCard pods={[POD]} />
      <ObjectMenu />
    </>,
    { at: "/c/prod/deployments", route: "/c/$cluster/$" }
  );

const openMenu = () =>
  fireEvent.contextMenu(
    screen.getByRole("link", { name: "Pod cart-6dc786ff6d-rh8q5" }),
    { clientX: 30, clientY: 40 }
  );

describe("the right-click menu of a pod in a workload's Pods tab", () => {
  /**
   * It offered Copy name, Copy link and a new tab, while the same pod's row
   * in the Pods list offered Restart and Delete: one pod, two menus.
   */
  it("offers the pod's actions, as the Pods list's row menu does", async () => {
    await draw();
    openMenu();
    const menu = await screen.findByRole("menu");
    for (const name of ["Copy name", "Restart", "Delete"]) {
      expect(within(menu).getByRole("menuitem", { name })).toBeInTheDocument();
    }
  });

  /** The dialog an item opens outlives the menu that opened it. */
  it("asks before restarting, by the pod's name", async () => {
    const user = userEvent.setup();
    await draw();
    openMenu();
    await user.click(await screen.findByRole("menuitem", { name: "Restart" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(
      within(dialog).getByText("Restart Pod shop/cart-6dc786ff6d-rh8q5?")
    ).toBeInTheDocument();
  });
});

describe("the right-click menu of an object in another cluster", () => {
  /**
   * A staging hit in the palette offered Restart and Delete, and they ran on
   * prod's namesake: every action goes to the window's cluster. Fails if the
   * menu offers an action or a peek for an object the window is not on, or
   * if Open points anywhere but the object's own cluster.
   */
  it("offers only what the object's own address can do", async () => {
    await renderWithRouter(
      <>
        <ResourceRef
          kind="Deployment"
          name="api"
          namespace="shop"
          linkOptions={{ cluster: "staging" }}
        />
        <ObjectMenu />
      </>,
      { at: "/c/prod/deployments", route: "/c/$cluster/$" }
    );
    const link = screen.getByRole("link", { name: "Deployment api" });
    expect(link).toHaveAttribute(
      "href",
      expect.stringMatching(/^\/c\/staging\//)
    );
    fireEvent.contextMenu(link, { clientX: 30, clientY: 40 });

    const menu = await screen.findByRole("menu");
    expect(
      within(menu).getByRole("menuitem", { name: "Copy name" })
    ).toBeInTheDocument();
    for (const name of [
      /^Restart/,
      /^Scale/,
      /^Delete/,
      /^Open in side panel/,
    ]) {
      expect(within(menu).queryByRole("menuitem", { name })).toBeNull();
    }
  });
});
