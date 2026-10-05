import { describe, expect, it, vi } from "vite-plus/test";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { ActionWarning } from "@/lib/governance";
import { renderWithRouter } from "@/test/render";

vi.mock("@/lib/commands", () => ({
  commands: { setAutoscalerBounds: vi.fn() },
}));

import { commands } from "@/lib/commands";
import { ScaleDialog } from "./ScaleDialog";

const stuck: ActionWarning = {
  key: "hpa:cart",
  subject: "The autoscaler cart",
  lead: "cart owns this replica count, and is stuck.",
  description: "It cannot act right now (FailedGetResourceMetric).",
  to: null,
  autoscaler: {
    name: "cart",
    namespace: "shop",
    minReplicas: 2,
    maxReplicas: 5,
  },
};

const open = () =>
  renderWithRouter(
    <ScaleDialog
      open
      kind="Deployment"
      current={2}
      busy={false}
      warnings={[stuck]}
      onOpenChange={() => {}}
      onSubmit={() => {}}
    />
  );

const field = (name: string) => screen.getByLabelText(name);

async function setBounds(min: string, max: string) {
  await userEvent.clear(field("minReplicas"));
  await userEvent.type(field("minReplicas"), min);
  await userEvent.clear(field("maxReplicas"));
  await userEvent.type(field("maxReplicas"), max);
}

describe("changing the autoscaler's bounds from the Scale dialog", () => {
  /** The warning the personas liked has to survive the editor added under it. */
  it("keeps the warning and offers the bounds under it", async () => {
    await open();
    expect(screen.getByText(stuck.lead)).toBeInTheDocument();
    expect(field("minReplicas")).toHaveValue(2);
    expect(field("maxReplicas")).toHaveValue(5);
  });

  /** The patch carries exactly the two numbers typed, and only after its own confirmation. */
  it("patches the autoscaler with the new bounds once confirmed", async () => {
    vi.mocked(commands.setAutoscalerBounds).mockResolvedValue();
    await open();
    await setBounds("3", "6");
    await userEvent.click(
      screen.getByRole("button", { name: "Change bounds" })
    );
    expect(commands.setAutoscalerBounds).not.toHaveBeenCalled();
    expect(
      screen.getByText("Set cart to minReplicas 3 and maxReplicas 6?")
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() =>
      expect(commands.setAutoscalerBounds).toHaveBeenCalledWith(
        "cart",
        "shop",
        3,
        6
      )
    );
  });

  it("will not offer bounds the API would refuse", async () => {
    await open();
    await setBounds("0", "5");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "minReplicas must be at least 1."
    );
    expect(
      screen.getByRole("button", { name: "Change bounds" })
    ).toBeDisabled();
    await setBounds("7", "5");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "minReplicas cannot be above maxReplicas."
    );
  });
});
