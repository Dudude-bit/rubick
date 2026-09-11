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
   * listens for `keydown` has to be named here with what it owns. A new
   * listener anywhere else fails this until it is.
   */
  it("knows every file that listens for a key", () => {
    const listeners = sources("src")
      .filter((path) =>
        /addEventListener\(\s*["']keydown["']/.test(readFileSync(path, "utf8"))
      )
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
});
