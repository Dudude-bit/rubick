import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DangerousConfirmDialog } from "@/components/ui/dangerous-confirm-dialog";
import { useClusterIdentityStore } from "@/stores/clusterIdentityStore";
import { useClusterStore } from "@/stores/clusterStore";

const PROD = "prod-eu-1";

beforeEach(() => {
  useClusterIdentityStore.setState({ marks: {} });
  useClusterStore.setState({ currentContext: PROD, isConnected: true });
});

const confirmButton = () => screen.getByRole("button", { name: "Delete" });

describe("a plain confirmation on critical infrastructure", () => {
  /** Without the gate a deletion on the marked cluster is one click, exactly what the mark exists to stop. */
  it("holds the button until the cluster's name is typed", () => {
    useClusterIdentityStore.getState().setCritical(PROD, true);
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        open
        title="Delete payments?"
        confirmLabel="Delete"
        onOpenChange={() => {}}
        onConfirm={onConfirm}
      />
    );

    expect(screen.getByRole("alert")).toHaveTextContent(PROD);
    expect(confirmButton()).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText(PROD), {
      target: { value: "prod-eu-2" },
    });
    expect(confirmButton()).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText(PROD), {
      target: { value: PROD },
    });
    expect(confirmButton()).toBeEnabled();
    fireEvent.click(confirmButton());
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  /** A guard armed by the name alone would fire on `product-catalog-dev` until someone found the setting. */
  it("asks nothing of a cluster that merely looks like production", () => {
    render(
      <ConfirmDialog
        open
        title="Delete payments?"
        confirmLabel="Delete"
        onOpenChange={() => {}}
        onConfirm={() => {}}
      />
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(confirmButton()).toBeEnabled();
  });
});

describe("a typed confirmation on critical infrastructure", () => {
  /** Typing the pod's name proves nothing about which cluster the pod is on. */
  it("asks for the cluster's name instead of the object's", () => {
    useClusterIdentityStore.getState().setCritical(PROD, true);
    const onConfirm = vi.fn();
    render(
      <DangerousConfirmDialog
        open
        title="Delete payments?"
        confirmationText="payments"
        confirmLabel="Delete"
        onOpenChange={() => {}}
        onConfirm={onConfirm}
      />
    );

    const input = screen.getByPlaceholderText(PROD);
    fireEvent.change(input, { target: { value: "payments" } });
    expect(confirmButton()).toBeDisabled();

    fireEvent.change(input, { target: { value: PROD } });
    expect(confirmButton()).toBeEnabled();
  });

  it("asks for the object's name everywhere else", () => {
    render(
      <DangerousConfirmDialog
        open
        title="Delete payments?"
        confirmationText="payments"
        confirmLabel="Delete"
        onOpenChange={() => {}}
        onConfirm={() => {}}
      />
    );
    fireEvent.change(screen.getByPlaceholderText("payments"), {
      target: { value: "payments" },
    });
    expect(confirmButton()).toBeEnabled();
  });
});
