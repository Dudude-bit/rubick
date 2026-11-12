import { readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { CODE_FILES } from "@/test/source-files";

const MODULES = CODE_FILES.filter(
  (path) => !path.startsWith("src/ui/generated/")
);
const KNOWN = new Set(MODULES);
const SPECIFIER = /(["'])((?:@\/|\.\.?\/)[^"'\n]*)\1/g;

function resolve(from: string, specifier: string): string | null {
  const base = specifier.startsWith("@/")
    ? join("src/ui", specifier.slice(2))
    : normalize(join(dirname(from), specifier));
  const found = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
  ].find((candidate) => KNOWN.has(candidate));
  return found ?? null;
}

/** The folder whose subtree may import `path`: the parent of its first `-` folder. */
function owner(path: string): string | null {
  if (!path.startsWith("src/ui/routes/")) return null;
  const parts = path.split("/");
  const dash = parts.findIndex((part, i) => i > 2 && part.startsWith("-"));
  return dash === -1 ? path : parts.slice(0, dash).join("/");
}

describe("code under a route", () => {
  /**
   * A `-` folder holds what its route and the routes below it share. Reached
   * from anywhere else, the folder stops saying where the code is used, which
   * is the whole reason the code was moved next to its address. A test may
   * reach across: a guard over every list's columns has to.
   */
  it("is imported only from inside the route that holds it", () => {
    const crossings = MODULES.flatMap((from) =>
      [...readFileSync(from, "utf8").matchAll(SPECIFIER)].flatMap(
        ([, , specifier]) => {
          const target = resolve(from, specifier);
          const scope = target && owner(target);
          return scope && !from.startsWith(`${scope}/`)
            ? [`${from} -> ${target}`]
            : [];
        }
      )
    );
    expect(MODULES.length).toBeGreaterThan(500);
    expect(crossings).toEqual([]);
  });
});
