import { describe, expect, it, vi } from "vite-plus/test";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  checkForUpdate: vi.fn().mockResolvedValue(null),
}));

import { renderWithRouter } from "@/test/render";
import { AboutSettings } from "./AboutSettings";

describe("About", () => {
  /** It had a version, Tauri and React, and no way to read how the app works. */
  it("links the documentation", async () => {
    await renderWithRouter(<AboutSettings />);
    expect(screen.getByText("Documentation")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /README on GitHub/ })
    ).toHaveAttribute("href", "https://github.com/Dudude-bit/rubick#readme");
  });

  /**
   * "Проверить обновления" answered with a toast that was gone or hidden, and
   * the line above it already said "latest version" before the click. Fails if
   * a finished check leaves nothing on the row to tell it from no check.
   */
  it("says when the last check got its answer, on the row itself", async () => {
    await renderWithRouter(<AboutSettings />);
    expect(screen.queryByText(/Checked at/)).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: /Check for updates/ })
    );
    expect(
      await screen.findByText(/Checked at \d\d:\d\d:\d\d\./)
    ).toBeInTheDocument();
  });
});
