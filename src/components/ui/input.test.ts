import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { CODE_FILES } from "@/test/source-files";

const root = join(import.meta.dirname, "..", "..", "..");

/**
 * macOS corrects text typed into a web view unless the field says not to.
 * The palette's own `<input>` did not, so "gwtest-app" became "Gwtest-app"
 * as it was typed — and every name, query and filter here is text nobody
 * wants corrected. `Input` says so; a hand-written `<input>` has to as well.
 */
describe("every text field", () => {
  it("turns off correction, capitalisation and spelling", () => {
    const loose: string[] = [];
    for (const path of CODE_FILES.filter((p) => p.endsWith(".tsx"))) {
      const source = readFileSync(join(root, path), "utf8");
      for (const match of source.matchAll(/<input\b/g)) {
        const tag = source.slice(
          match.index,
          source.indexOf("/>", match.index)
        );
        if (/type="(checkbox|radio|file|range|hidden)"/.test(tag)) continue;
        const off = [
          'autoComplete="off"',
          'autoCorrect="off"',
          'autoCapitalize="off"',
          "spellCheck={false}",
        ];
        if (!off.every((attr) => tag.includes(attr)))
          loose.push(
            `${path}:${source.slice(0, match.index).split("\n").length}`
          );
      }
    }
    expect(loose).toEqual([]);
  });
});
