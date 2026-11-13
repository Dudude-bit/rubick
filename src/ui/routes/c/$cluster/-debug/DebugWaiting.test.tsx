import { describe, expect, it, vi } from "vite-plus/test";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { DebugNotReady, DebugPolling } from "./DebugWaiting";

const notReady = (over: Partial<Parameters<typeof DebugNotReady>[0]> = {}) => (
  <DebugNotReady
    open
    title="Container not ready"
    description="did not become ready"
    statusReason="ImagePullBackOff"
    deleting={false}
    onLeave={vi.fn()}
    onDelete={vi.fn()}
    onKeepWaiting={vi.fn()}
    {...over}
  />
);

describe("the debug dialog that says the container did not come up", () => {
  /**
   * Delete pod awaited the write with nothing disabled, so a double click
   * sent two deletes. Fails if any button stays live while it runs, or the
   * delete does not show it is working.
   */
  it("holds every button and shows Delete Pod working while the delete runs", () => {
    render(notReady({ deleting: true }));
    const del = screen.getByRole("button", { name: "Delete Pod" });
    expect(del).toBeDisabled();
    expect(del).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: "Leave" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Keep Waiting" })).toBeDisabled();
  });

  it("deletes once on a click while idle", async () => {
    const onDelete = vi.fn();
    render(notReady({ onDelete }));
    await userEvent.click(screen.getByRole("button", { name: "Delete Pod" }));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });
});

describe("the debug dialog that waits for the container", () => {
  /** Fails if the wait stops naming the status the cluster last reported. */
  it("shows the cluster's last status and the time spent", () => {
    render(
      <DebugPolling
        open
        onOpenChange={() => {}}
        title="Waiting"
        description="for pod"
        statusReason="ContainerCreating"
        elapsedSeconds={12}
        timeoutSeconds={60}
        progressPercent={20}
        onCancel={vi.fn()}
      />
    );
    expect(screen.getByText("ContainerCreating")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toBeInTheDocument();
  });
});
