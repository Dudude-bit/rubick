import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { CODE_FILES } from "@/test/source-files";

/** The attributes of the JSX element that carries `role="listbox"`. */
function listboxTags(source: string): string[] {
  const tags: string[] = [];
  for (const match of source.matchAll(/<(\w+)\s/g)) {
    const end = source.indexOf(">", match.index);
    if (end === -1) continue;
    const tag = source.slice(match.index, end);
    if (tag.includes('role="listbox"')) tags.push(tag);
  }
  return tags;
}

describe("a list the arrow keys walk", () => {
  /**
   * Two patterns are correct and one is a silent failure. A listbox that
   * moves real focus into its options announces itself through the focused
   * element; a listbox that keeps focus on the box and moves a highlight
   * announces nothing at all unless `aria-activedescendant` says which row
   * is on. Both alert lists were the second kind, with the row highlighted
   * on screen and nothing said out loud.
   *
   * `tabIndex` on the box is what tells the two apart: it is there precisely
   * because the box, not the row, is what gets focused.
   */
  it("names its selected row when the box keeps the focus", () => {
    const silent: string[] = [];
    let checked = 0;
    for (const file of CODE_FILES) {
      for (const tag of listboxTags(readFileSync(file, "utf8"))) {
        if (!/tabIndex=\{0\}/.test(tag)) continue;
        checked++;
        if (!tag.includes("aria-activedescendant"))
          silent.push(file.replace(/^src\//, ""));
      }
    }
    expect(silent).toEqual([]);
    expect(checked, "a guard that reads nothing passes").toBeGreaterThan(0);
  });
});
