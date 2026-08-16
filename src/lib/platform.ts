/** Host OS as reported by the backend (`std::env::consts::OS`). */
let hostOs = "linux";

export function setHostOs(os: string): void {
  hostOs = os;
}

export function isMac(os: string = hostOs): boolean {
  return os === "macos";
}

/**
 * Render a logical shortcut for display on a given platform.
 *
 * Shortcuts are declared as `mod+K`, never as `⌘K`: the glyph is
 * macOS-only, and the modifier itself differs — Command there, Control
 * on Windows and Linux. Handlers match `e.metaKey || e.ctrlKey`, so the
 * logical form is also what the runtime actually honours.
 */
export function formatShortcut(shortcut: string, os: string = hostOs): string {
  const mac = isMac(os);
  const parts = shortcut.split("+");
  const rendered = parts.map((part) => {
    switch (part.toLowerCase()) {
      case "mod":
        return mac ? "⌘" : "Ctrl";
      // Literal Control, not "the platform's command key": Cmd+Tab is the
      // macOS app switcher, so tab cycling is Ctrl+Tab everywhere.
      case "ctrl":
        return mac ? "⌃" : "Ctrl";
      case "shift":
        return mac ? "⇧" : "Shift";
      case "alt":
        return mac ? "⌥" : "Alt";
      default:
        return part;
    }
  });
  // macOS stacks glyphs without separators; the others need them.
  return mac ? rendered.join("") : rendered.join("+");
}
