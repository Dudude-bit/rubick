import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  checkForUpdate: vi.fn().mockResolvedValue(null),
}));

import { renderWithRouter } from "@/test/render";
import { checkForUpdate } from "@/lib/host";
import { useUpdaterStore } from "@/stores/updaterStore";
import { AboutSettings } from "./AboutSettings";

beforeEach(() =>
  useUpdaterStore.setState({
    available: false,
    checking: false,
    checkedAt: null,
    error: undefined,
  })
);

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
  /**
   * Lena's debug build said "latest version installed" with nothing to show a
   * check had reached the release feed. Fails if the row claims no newer
   * release before a check has answered, or after one that failed.
   */
  it("says there is no newer release only after a check that got the feed's answer", async () => {
    await renderWithRouter(<AboutSettings />);
    expect(screen.getByText("Not checked for updates yet")).toBeInTheDocument();
    expect(screen.queryByText(/No newer release/)).toBeNull();

    vi.mocked(checkForUpdate).mockRejectedValueOnce(
      new Error("Could not fetch a valid release JSON from the remote")
    );
    await userEvent.click(
      screen.getByRole("button", { name: /Check for updates/ })
    );
    expect(
      await screen.findByText("Could not check for updates")
    ).toBeInTheDocument();
    expect(screen.queryByText(/No newer release/)).toBeNull();

    await userEvent.click(
      screen.getByRole("button", { name: /Check for updates/ })
    );
    expect(
      await screen.findByText("No newer release in the release feed")
    ).toBeInTheDocument();
  });

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
