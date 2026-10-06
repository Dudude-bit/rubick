import { describe, expect, it } from "vite-plus/test";
import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { PodInfo } from "@/generated/types";
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
      within(dialog).getByText("Restart pod shop/cart-6dc786ff6d-rh8q5?")
    ).toBeInTheDocument();
  });
});
