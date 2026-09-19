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
      // The named keys, so the one renderer covers every key the shortcut
      // table can hold. The list of shortcuts used to spell these itself and
      // came out saying "⇧" on Windows and "Ctrl+Tab" on a Mac, two paces
      // from a tab strip drawing the same keys the app's own way.
      // Capitalised, not turned into glyphs: `ScopeTabs` already prints
      // `mod+Enter` and the word is what it has always shown. The list of
      // shortcuts spelled these itself and drew "↵" beside a tab strip
      // saying "Enter"; the fix is that the list follows the app, not that
      // the app follows the list.
      case "esc":
        return "Esc";
      case "enter":
        return "Enter";
      case "tab":
        return "Tab";
      case "del":
        return "Del";
      case "space":
        return "Space";
      default:
        return part;
    }
  });
  // macOS stacks glyphs without separators; the others need them.
  return mac ? rendered.join("") : rendered.join("+");
}
