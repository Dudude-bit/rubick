import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";

vi.mock("@/lib/commands", () => ({
  commands: new Proxy({}, { get: () => () => new Promise(() => {}) }),
}));

const POD_PEEK = "/events?peek=pods/k8s-gui-test/crash-demo-56588f6b8c-8bj9v";

async function panel() {
  const { PeekPanel } = await import("./PeekPanel");
  renderWithProviders(<PeekPanel />, { initialEntries: [POD_PEEK] });
}

describe("the peek panel's body, loaded apart from the window", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  /**
   * Opened before its body has loaded, the panel is still the object: its
   * name from the address and the overview's outline, never an empty box.
   */
  it("names the object and draws the outline while the body loads", async () => {
    await panel();
    expect(screen.getByRole("dialog")).toHaveAccessibleName(
      "Pod crash-demo-56588f6b8c-8bj9v"
    );
    expect(screen.getByTestId("peek-skeleton")).toBeInTheDocument();
    // A fresh module graph under a loaded suite takes a while to import.
    expect(
      await screen.findByRole("tablist", undefined, { timeout: 15_000 })
    ).toBeInTheDocument();
  }, 20_000);

  /** A body fetched ahead of the click is there on the first render. */
  it("opens a body fetched ahead of time in the same render", async () => {
    const { preloadPeekContent } = await import("./peek-loader");
    await preloadPeekContent();
    await panel();
    expect(screen.getByRole("tablist")).toBeInTheDocument();
  });
});
