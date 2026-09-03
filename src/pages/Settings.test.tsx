import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { SettingsRedirect } from "./Settings";
import { useSettingsStore } from "@/stores/settingsStore";

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/" element={<div>home page</div>} />
        <Route path="/settings/*" element={<SettingsRedirect />} />
      </Routes>
    </MemoryRouter>
  );
}

describe("the address Settings used to have", () => {
  beforeEach(() => {
    useSettingsStore.setState({ open: false, section: "registries" });
  });

  /**
   * A tab persisted by an older build still points at `/settings/about`,
   * and so does every link written before the move. Would break if the
   * route were simply dropped: the tab would render the blank an unmatched
   * route leaves, and the section in the address would be lost.
   */
  it("opens the layer on the section named and sends the tab home", async () => {
    renderAt("/settings/about");

    expect(await screen.findByText("home page")).toBeInTheDocument();
    expect(useSettingsStore.getState()).toMatchObject({
      open: true,
      section: "about",
    });
  });

  it("opens where Settings was last for a bare /settings", async () => {
    renderAt("/settings");

    expect(await screen.findByText("home page")).toBeInTheDocument();
    expect(useSettingsStore.getState()).toMatchObject({
      open: true,
      section: "registries",
    });
  });

  it("opens the default section for a name nothing is called", async () => {
    renderAt("/settings/nonsense");

    expect(await screen.findByText("home page")).toBeInTheDocument();
    expect(useSettingsStore.getState().section).toBe("appearance");
  });
});
