import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { CODE_FILES } from "@/test/source-files";

const root = join(import.meta.dirname, "..", "..");

/**
 * `OutLink` draws its own arrow after the words. Two buttons added another
 * before them, so "Open in Prometheus" carried an arrow at each end.
 */
describe("a link out of the app", () => {
  it("is not given a second arrow by its caller", () => {
    const doubled: string[] = [];
    for (const path of CODE_FILES.filter((p) => p.endsWith(".tsx"))) {
      const source = readFileSync(join(root, path), "utf8");
      for (const match of source.matchAll(/<OutLink\b/g)) {
        const end = source.indexOf("</OutLink>", match.index);
        if (source.slice(match.index, end).includes("<ExternalLink"))
          doubled.push(
            `${path}:${source.slice(0, match.index).split("\n").length}`
          );
      }
    }
    expect(doubled).toEqual([]);
  });
});
