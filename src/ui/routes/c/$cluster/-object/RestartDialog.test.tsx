import { describe, expect, it, vi } from "vite-plus/test";
import { screen } from "@testing-library/react";
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

  /** The confirm button holds focus, so Enter is the confirmation and nothing else is needed. */
  it("restarts on Enter once it is open", async () => {
    const restart = await openRestart();
    await screen.findByTestId("restart-plan");
    await userEvent.keyboard("{Enter}");
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
