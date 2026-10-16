import { describe, expect, it, vi } from "vite-plus/test";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { ActionWarning } from "@/lib/governance";
import { renderWithRouter } from "@/test/render";

vi.mock("@/lib/commands", () => ({
  commands: { setAutoscalerBounds: vi.fn(), checkAccess: vi.fn() },
}));

import { commands } from "@/lib/commands";
import { useClusterStore } from "@/stores/clusterStore";
import type { AccessQuery } from "@/generated/types";
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

const open = (onSubmit: (replicas: number) => void = () => {}) =>
  renderWithRouter(
    <ScaleDialog
      open
      kind="Deployment"
      name="web"
      namespace="shop"
      current={2}
      busy={false}
      warnings={[stuck]}
      onOpenChange={() => {}}
      onSubmit={onSubmit}
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

describe("the keyboard in a Scale dialog with an autoscaler's bounds", () => {
  /**
   * With the bounds cached they drew first and took the focus, so "open,
   * type 3, Enter" typed into minReplicas and nothing scaled.
   */
  it("puts the cursor in the replica count, and Enter scales to what was typed", async () => {
    const onSubmit = vi.fn();
    await open(onSubmit);
    expect(field("Number of replicas")).toHaveFocus();
    await userEvent.keyboard("3{Enter}");
    expect(onSubmit).toHaveBeenCalledWith(3);
  });

  /** Enter in a bounds field did nothing at all; it belongs to the bounds. */
  it("asks to change the bounds on Enter in minReplicas", async () => {
    await open();
    await userEvent.clear(field("minReplicas"));
    await userEvent.type(field("minReplicas"), "3{Enter}");
    expect(
      screen.getByText("Set cart to minReplicas 3 and maxReplicas 5?")
    ).toBeInTheDocument();
    expect(commands.setAutoscalerBounds).not.toHaveBeenCalled();
  });

  /** Enter on bounds nobody changed says so, instead of nothing. */
  it("says the bounds are unchanged on Enter with nothing changed", async () => {
    await open();
    await userEvent.type(field("maxReplicas"), "{Enter}");
    expect(screen.getByRole("status")).toHaveTextContent(
      "cart already has minReplicas 2 and maxReplicas 5."
    );
  });
});

describe("the autoscaler's bounds for a reader who may not change it", () => {
  /**
   * The Scale dialog offered new bounds to a reader whose Role reads
   * autoscalers and patches none. Fails if Change bounds stays live, or
   * reaches its confirmation, while can-i patch horizontalpodautoscalers
   * says no.
   */
  it("greys Change bounds with the can-i question and patches nothing", async () => {
    vi.mocked(commands.checkAccess).mockImplementation(
      async (queries: AccessQuery[]) =>
        queries.map((query) => ({ ...query, allowed: false }))
    );
    useClusterStore.setState((s) => ({
      currentContext: "prod",
      isConnected: true,
      connectionAttemptId: s.connectionAttemptId + 1,
    }));
    await open();
    const change = () => screen.getByRole("button", { name: "Change bounds" });
    await waitFor(() =>
      expect(change()).toHaveAttribute("aria-disabled", "true")
    );
    await userEvent.hover(change());
    expect(
      (
        await screen.findAllByText(
          /can-i patch horizontalpodautoscalers.autoscaling -n shop/
        )
      ).length
    ).toBeGreaterThan(0);
    await setBounds("3", "6");
    await userEvent.click(change());
    expect(screen.queryByText(/Set cart to minReplicas/)).toBeNull();
    expect(commands.setAutoscalerBounds).not.toHaveBeenCalled();
  });
});
