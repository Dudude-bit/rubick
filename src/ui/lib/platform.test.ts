import { describe, expect, it } from "vitest";
import { formatShortcut, hostOsFromUserAgent } from "@/lib/platform";

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

describe("the host OS before anything has been asked", () => {
  /**
   * The first render waited up to two seconds for the backend to name the
   * OS; the webview's own user agent already says it. These are the three
   * webviews Tauri runs in.
   */
  it("reads each webview's user agent as its platform", () => {
    expect(
      hostOsFromUserAgent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)"
      )
    ).toBe("macos");
    expect(
      hostOsFromUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0"
      )
    ).toBe("windows");
    expect(
      hostOsFromUserAgent(
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15"
      )
    ).toBe("linux");
  });
});
