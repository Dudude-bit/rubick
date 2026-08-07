import { describe, expect, it } from "vitest";
import { formatShortcut } from "@/lib/platform";

describe("formatShortcut", () => {
  it("renders mod as the command glyph on macOS", () => {
    expect(formatShortcut("mod+K", "macos")).toBe("⌘K");
  });

  it("renders mod as Ctrl on windows and linux", () => {
    expect(formatShortcut("mod+K", "windows")).toBe("Ctrl+K");
    expect(formatShortcut("mod+K", "linux")).toBe("Ctrl+K");
  });

  it("renders shift and alt per platform", () => {
    expect(formatShortcut("mod+shift+P", "macos")).toBe("⌘⇧P");
    expect(formatShortcut("mod+shift+P", "linux")).toBe("Ctrl+Shift+P");
    expect(formatShortcut("alt+Enter", "macos")).toBe("⌥Enter");
    expect(formatShortcut("alt+Enter", "windows")).toBe("Alt+Enter");
  });

  // Cmd+Tab is the macOS app switcher, so tab cycling has to say Control
  // outright rather than "whatever this platform calls the command key".
  it("renders a literal ctrl apart from mod", () => {
    expect(formatShortcut("ctrl+Tab", "macos")).toBe("⌃Tab");
    expect(formatShortcut("ctrl+Tab", "linux")).toBe("Ctrl+Tab");
  });

  it("passes unmodified keys through", () => {
    expect(formatShortcut("Esc", "linux")).toBe("Esc");
  });

  it("falls back to the ctrl form for an unknown os", () => {
    expect(formatShortcut("mod+K", "freebsd")).toBe("Ctrl+K");
  });
});
