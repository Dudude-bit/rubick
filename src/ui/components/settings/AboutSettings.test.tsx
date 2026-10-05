import { describe, expect, it } from "vite-plus/test";
import { screen } from "@testing-library/react";

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
});
