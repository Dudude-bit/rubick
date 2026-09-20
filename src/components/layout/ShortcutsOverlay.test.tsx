import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { en } from "@/i18n/catalogue";
import { SHORTCUTS } from "@/lib/shortcuts";
import { useShortcutsOverlayStore } from "@/stores/shortcutsOverlayStore";
import { ShortcutsOverlay } from "./ShortcutsOverlay";

describe("the list behind ?", () => {
  /** Drawn from the table, so it is complete by construction; this holds it to that. */
  it("names every shortcut the table knows", () => {
    useShortcutsOverlayStore.setState({ open: true });
    render(<ShortcutsOverlay />);
    for (const entry of SHORTCUTS) {
      expect(
        screen.getAllByText(en.shortcuts[entry.labelKey]).length,
        entry.id
      ).toBeGreaterThan(0);
    }
  });

  it("draws a chord as one key, then the other", () => {
    useShortcutsOverlayStore.setState({ open: true });
    render(<ShortcutsOverlay />);
    const pods = screen.getByText(en.shortcuts.goPods).closest("li");
    expect(pods).toHaveTextContent(/g.*then.*p/);
  });
});
