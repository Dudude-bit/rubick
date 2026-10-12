import { describe, expect, it, vi } from "vite-plus/test";
import { screen } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";

import { renderWithRouter } from "@/test/render";
import { NodeRef } from "./NodeRef";

describe("a link to a node", () => {
  /**
   * Marco's pod page linked a node he could not read, with nothing to say so
   * until the click landed on a refusal. Fails if a refused node's link loses
   * its padlock, or a node that answered gains one.
   */
  it("carries a padlock where the cluster refused the node, and none where it answered", async () => {
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === "get_node")
        throw { code: "PERMISSION_DENIED", message: "nodes is forbidden" };
      return undefined;
    });
    await renderWithRouter(<NodeRef name="k3d-agent-0" />);
    expect(await screen.findByTestId("node-refused")).toHaveAttribute(
      "aria-label",
      "Your access does not allow reading Node k3d-agent-0."
    );
    expect(
      screen.getByRole("link", { name: "Node k3d-agent-0" })
    ).toBeInTheDocument();

    vi.mocked(invoke).mockImplementation(async (command: string) =>
      command === "get_node" ? { name: "k3d-agent-1", labels: {} } : undefined
    );
    await renderWithRouter(<NodeRef name="k3d-agent-1" />);
    await screen.findByRole("link", { name: "Node k3d-agent-1" });
    expect(screen.getAllByTestId("node-refused")).toHaveLength(1);
    vi.mocked(invoke).mockImplementation(async () => undefined);
  });
});
