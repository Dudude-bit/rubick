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

/** Every class literal written in a className attribute, `cn()` included. */
function classesIn(attrs: string): string {
  const direct = /className=(?:"([^"]*)"|\{`([^`]*)`\})/.exec(attrs);
  if (direct) return direct[1] ?? direct[2] ?? "";
  const call = /className=\{cn\(([^)]*)\)\}/.exec(attrs);
  if (!call) return "";
  return [...call[1].matchAll(/"([^"]*)"|`([^`]*)`/g)]
    .map((m) => m[1] ?? m[2])
    .join(" ");
}

/**
 * A height the viewport can be measured against.
 *
 * `h-full` and `size-full` are per cent and resolve against the parent's
 * *specified* height, which is `auto` on a flex-sized root — so they are not
 * a height of one's own. Neither is `min-h-*`: a minimum leaves the computed
 * `height` at `auto`, so the viewport grows to its content exactly as before
 * and the root clips it. This accepted `min-h-64` for one commit, because
 * the prefix list was widened to carve out `min-h-0` — which never needed
 * carving out, since a minimum was never a height here.
 */
function definiteHeight(classes: string): boolean {
  return classes
    .split(/\s+/)
    .some((c) => /^(h|max-h|size)-/.test(c) && !/-(full|auto)$/.test(c));
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
      for (const m of text.matchAll(/<ScrollArea\b([^>]*)>/gs)) {
        const classes = classesIn(m[1]);
        if (!definiteHeight(classes)) {
          wrong.push(
            `${path.replace(/^src\//, "")}: <ScrollArea className="${classes}">`
          );
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  /**
   * The guard's own trap: `h-full` and `size-full` are `height: 100%`, the
   * exact construct this file exists to forbid, and the first version of the
   * check waved them through because they start with `h-`. It caught only
   * the one spelling that happened to be in What's New.
   */
  it("counts a percentage height as no height at all", () => {
    expect(definiteHeight("h-[200px] w-full")).toBe(true);
    expect(definiteHeight("max-h-[60vh]")).toBe(true);
    expect(definiteHeight("h-64")).toBe(true);
    expect(definiteHeight("h-full")).toBe(false);
    expect(definiteHeight("size-full")).toBe(false);
    expect(definiteHeight("min-h-0 flex-1 pr-3")).toBe(false);
    // A minimum is not a height: the computed one stays `auto`, and the
    // viewport grows to its content just as it did with no class at all.
    expect(definiteHeight("min-h-64")).toBe(false);
    expect(definiteHeight("min-h-[20rem] flex-1")).toBe(false);
  });

  /** A className the guard cannot read must not be reported as a failure. */
  it("reads the classes out of a cn() call as well as a bare string", () => {
    expect(classesIn('className={cn("h-64", extra)}')).toBe("h-64");
    expect(classesIn('className="h-full w-full"')).toBe("h-full w-full");
    expect(classesIn("className={`h-${n}`}")).toBe("h-${n}");
  });

  /** A guard that reads nothing passes forever. */
  it("reads the files it is meant to be checking", () => {
    const all = sources("src").filter((path) =>
      /<ScrollArea\b/.test(readFileSync(path, "utf8"))
    );
    expect(all.length).toBeGreaterThan(0);
  });
});
