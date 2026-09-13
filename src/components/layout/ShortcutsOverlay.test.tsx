import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { formatShortcut } from "@/lib/platform";
import { SHORTCUTS } from "@/lib/shortcuts";
import { useShortcutsStore } from "@/stores/shortcutsStore";
import { ShortcutsOverlay } from "./ShortcutsOverlay";

describe("ShortcutsOverlay", () => {
  beforeEach(() => useShortcutsStore.setState({ open: false }));

  /** `?` anywhere opens the list; inside a text field it is a character. Would break if the guard went. */
  it("opens on ? outside a text field and stays shut inside one", async () => {
    render(
      <>
        <input aria-label="field" />
        <ShortcutsOverlay />
      </>
    );
    fireEvent.keyDown(screen.getByLabelText("field"), { key: "?" });
    expect(screen.queryByText("Keyboard shortcuts")).toBeNull();
    fireEvent.keyDown(window, { key: "?" });
    expect(await screen.findByText("Keyboard shortcuts")).toBeInTheDocument();
    expect(
      screen.getByText("Copy a link to where you are")
    ).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "?" });
    await waitFor(() =>
      expect(screen.queryByText("Keyboard shortcuts")).toBeNull()
    );
  });

  /** A shortcut spelled with a glyph the formatter does not know would render as its raw string. */
  it("spells every listed key on both platforms", () => {
    for (const group of SHORTCUTS)
      for (const item of group.items)
        for (const key of item.keys) {
          expect(formatShortcut(key, "macos")).not.toContain("mod");
          expect(formatShortcut(key, "linux")).not.toContain("mod");
        }
  });
});
