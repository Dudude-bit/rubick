import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name))
      out.push(path);
  }
  return out;
}

describe("ScrollArea", () => {
  /**
   * `ScrollArea` asks its viewport for `height: 100%`, and a percentage
   * height resolves against the parent's *specified* height. A root sized by
   * its flex parent has `height: auto`, so in this webview the viewport grew
   * to its own content instead — 892px of release notes inside a 581px root,
   * the root's `overflow-hidden` ate the rest, and What's New ended mid-word
   * with no scrollbar anywhere and nothing failing.
   *
   * So a `ScrollArea` needs a height of its own — `h-64`, `h-[200px]`,
   * `max-h-[60vh]`. Where the height comes from a flex parent, the scroller
   * has to be the element itself: `min-h-0 flex-1 overflow-y-auto
   * scrollbar-thin`, which measures itself and needs no percentage.
   */
  it("is never given its height by a flex parent", () => {
    const wrong: string[] = [];
    for (const path of sources("src")) {
      const text = readFileSync(path, "utf8");
      for (const m of text.matchAll(/<ScrollArea\b([^>]*)>/g)) {
        const attrs = m[1];
        const className = /className=(?:"([^"]*)"|\{`([^`]*)`\})/.exec(attrs);
        const classes = className?.[1] ?? className?.[2] ?? "";
        const ownHeight = /(^|\s)(h-|max-h-|size-)/.test(classes);
        if (!ownHeight) {
          wrong.push(
            `${path.replace(/^src\//, "")}: <ScrollArea className="${classes}">`
          );
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  /** A guard that reads nothing passes forever. */
  it("reads the files it is meant to be checking", () => {
    const all = sources("src").filter((path) =>
      /<ScrollArea\b/.test(readFileSync(path, "utf8"))
    );
    expect(all.length).toBeGreaterThan(0);
  });
});
