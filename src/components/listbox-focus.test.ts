import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "generated" || name === "node_modules") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files(path, out);
    else if (/\.tsx$/.test(path) && !/\.test\.tsx$/.test(path)) out.push(path);
  }
  return out;
}

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
    for (const file of files("src")) {
      for (const tag of listboxTags(readFileSync(file, "utf8"))) {
        if (!/tabIndex=\{0\}/.test(tag)) continue;
        if (!tag.includes("aria-activedescendant"))
          silent.push(file.replace(/^src\//, ""));
      }
    }
    expect(silent).toEqual([]);
  });
});
