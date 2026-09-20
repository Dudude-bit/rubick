import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { en } from "@/i18n/catalogue";
import { ru } from "@/i18n/ru";
import { KEYDOWN_SITES, SECTIONS, SHORTCUTS } from "./shortcuts";

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      sources(path, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(path);
    }
  }
  return out;
}

describe("the one table of shortcuts", () => {
  /**
   * The completeness test the plan asks for. A shortcut added in a
   * component's own listener is invisible to the overlay, so every file that
   * answers a chord has to be named here with what it owns. A new one
   * anywhere else fails this until it is.
   *
   * Both ways of listening count. Sweeping only `addEventListener` missed
   * three files that answer ⌘-chords from a React `onKeyDown` prop — Ctrl+A
   * in the log list among them — and the second guard below could not see
   * them either, because none of the three draws a hint. A handler that only
   * reads `event.key` is a control answering its own Enter, not a shortcut.
   */
  it("knows every file that listens for a key", () => {
    const listeners = sources("src")
      .filter((path) => {
        const text = readFileSync(path, "utf8");
        if (/addEventListener\(\s*["']keydown["']/.test(text)) return true;
        return (
          /onKeyDown/.test(text) && /\b(metaKey|ctrlKey|altKey)\b/.test(text)
        );
      })
      .map((path) => path.replace(/\\/g, "/"));
    const unlisted = listeners.filter((path) => !(path in KEYDOWN_SITES));
    expect(unlisted).toEqual([]);
    for (const site of Object.keys(KEYDOWN_SITES)) {
      expect(
        listeners,
        `${site} no longer listens; drop it from the table`
      ).toContain(site);
    }
  });

  it("has a sentence for every shortcut in both languages", () => {
    for (const entry of SHORTCUTS) {
      expect(en.shortcuts[entry.labelKey], entry.id).toBeTruthy();
      expect(ru.shortcuts[entry.labelKey], entry.id).toBeTruthy();
    }
  });

  it("gives no two shortcuts the same keys within a section", () => {
    for (const section of SECTIONS) {
      const seen = new Set<string>();
      for (const entry of SHORTCUTS.filter((e) => e.section === section)) {
        const keys = entry.keys.join(" ");
        expect(seen.has(keys), `${section}: ${keys}`).toBe(false);
        seen.add(keys);
      }
    }
  });

  it("sends every chord somewhere and every page key to a tab", () => {
    for (const entry of SHORTCUTS) {
      if (entry.section === "navigate") {
        expect(entry.keys).toHaveLength(2);
        expect(entry.path, entry.id).toBeTruthy();
      }
      if (entry.section === "page") expect(entry.tab, entry.id).toBeTruthy();
    }
  });

  /**
   * The other half of "every key the app answers to": a shortcut the app
   * *prints* on screen has to be in the table that claims to list them all.
   * The keydown sweep above cannot see these — they are written as React
   * `onKeyDown` props, not window listeners — and the Files tab was printing
   * its own hint for `mod+s` two screens from an overlay that had never
   * heard of it.
   */
  it("holds every shortcut the app draws a hint for", () => {
    const advertised = new Set<string>();
    for (const path of sources("src")) {
      const text = readFileSync(path, "utf8");
      for (const m of text.matchAll(/formatShortcut\("([^"]+)"\)/g)) {
        const key = m[1].toLowerCase();
        // A lone modifier is printed inside a sentence — "⌘-click to add
        // another" — and is not a key combination the app answers to.
        if (!key.includes("+")) continue;
        advertised.add(key);
      }
    }
    const listed = new Set(
      SHORTCUTS.flatMap((entry) => entry.keys.map((k) => k.toLowerCase()))
    );
    const missing = [...advertised].filter((key) => !listed.has(key));
    expect(missing).toEqual([]);
  });
});
