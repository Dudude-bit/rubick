import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ScaleDialog } from "./ScaleDialog";
import { useClusterIdentityStore } from "@/stores/clusterIdentityStore";
import { useClusterStore } from "@/stores/clusterStore";

const PROD = "prod-eu-1";

const scaleButton = () => screen.getByRole("button", { name: /scale/i });

const scale = (over: Partial<Parameters<typeof ScaleDialog>[0]> = {}) => (
  <ScaleDialog
    open
    kind="Deployment"
    current={3}
    busy={false}
    onOpenChange={() => {}}
    onSubmit={() => {}}
    {...over}
  />
);

beforeEach(() => {
  useClusterIdentityStore.setState({ marks: {} });
  useClusterStore.setState({ currentContext: PROD, isConnected: true });
});

afterEach(() => {
  useClusterIdentityStore.setState({ marks: {} });
  useClusterStore.setState({ currentContext: null, isConnected: false });
});

describe("scaling on critical infrastructure", () => {
  /**
   * Scaling a workload to zero is the change the dialog's red band warns
   * about; without the gate it was still one click, which is exactly what the
   * mark on the cluster exists to stop.
   */
  it("holds the scale button until the cluster's name is typed", async () => {
    useClusterIdentityStore.getState().setCritical(PROD, true);
    const onSubmit = vi.fn();
    render(scale({ onSubmit }));

    expect(screen.getByRole("alert")).toHaveTextContent(PROD);
    expect(scaleButton()).toBeDisabled();

    await userEvent.type(screen.getByPlaceholderText(PROD), PROD);
    expect(scaleButton()).toBeEnabled();

    await userEvent.click(scaleButton());
    expect(onSubmit).toHaveBeenCalledWith(3);
  });

  /**
   * A production-looking name is a guess, never the answer: a guard armed by
   * the name alone would sit on `prod-catalog-dev` until someone found the
   * setting that turns it off.
   */
  it("asks nothing of a cluster nobody marked", () => {
    render(scale());
    expect(screen.queryByRole("alert")).toBeNull();
    expect(scaleButton()).toBeEnabled();
  });
});
