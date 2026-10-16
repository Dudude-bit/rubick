import { describe, expect, it, vi } from "vite-plus/test";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { UseMutationResult } from "@tanstack/react-query";

import { renderWithProviders } from "@/test/render";
import { RestartAction } from "./RestartDialog";

function mutation() {
  return {
    mutate: vi.fn(),
    isPending: false,
  } as unknown as UseMutationResult<void, Error, void>;
}

async function openRestart() {
  const restart = mutation();
  renderWithProviders(
    <RestartAction
      kind="Deployment"
      name="cart"
      namespace="shop"
      plan={{ strategy: "rolling", replicas: 3, surge: 1, unavailable: 1 }}
      intercept={null}
      mutation={restart}
    />
  );
  await userEvent.click(screen.getByRole("button", { name: /Restart/ }));
  return restart;
}

describe("a detail page's Restart", () => {
  /** Dana restarted `cart` by accident: the click itself must restart nothing. */
  it("restarts nothing on the click that opens it", async () => {
    const restart = await openRestart();
    expect(restart.mutate).not.toHaveBeenCalled();
    expect(await screen.findByTestId("restart-plan")).toHaveTextContent(
      "Replaces 3 pods: at most 1 unavailable and 1 extra at a time."
    );
  });

  /**
   * The Restart button held focus, so a stray Enter restarted. Fails if
   * Cancel is not focused when the dialog opens, or if Enter restarts.
   */
  it("opens with the cursor on Cancel, so Enter restarts nothing", async () => {
    const restart = await openRestart();
    await screen.findByTestId("restart-plan");
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(restart.mutate).not.toHaveBeenCalled();
    expect(screen.queryByTestId("restart-plan")).toBeNull();
  });

  /** Dana saw no ring on the focused Cancel: a dialog opened by a click focuses it from code, which is never `:focus-visible`. Fails if the ring hangs on that alone. */
  it("rings the focused Cancel on plain focus, however the dialog was opened", async () => {
    await openRestart();
    await screen.findByTestId("restart-plan");
    const cancel = screen.getByRole("button", { name: "Cancel" });
    expect(cancel).toHaveFocus();
    expect(cancel.className.split(" ")).toEqual(
      expect.arrayContaining([
        "data-autofocus:focus:ring-1",
        "data-autofocus:focus:ring-info",
      ])
    );
  });

  /** Confirming is a deliberate click on Restart, which still restarts. */
  it("restarts on a click on Restart", async () => {
    const restart = await openRestart();
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Restart" })
    );
    expect(restart.mutate).toHaveBeenCalledTimes(1);
  });

  it("restarts nothing when cancelled", async () => {
    const restart = await openRestart();
    await userEvent.click(
      await screen.findByRole("button", { name: "Cancel" })
    );
    expect(restart.mutate).not.toHaveBeenCalled();
  });
});
