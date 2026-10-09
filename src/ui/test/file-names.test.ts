import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vite-plus/test";

const MODULE = /(\/index)?\.(ts|tsx|js|jsx|mjs|cjs)$/;

describe("file names", () => {
  /**
   * macOS and Windows match names regardless of case, so `./Attached` finds
   * `attached.ts` there and `Attached.tsx` here: the macOS build broke on a
   * pair Linux never noticed. Two modules an import cannot tell apart on a
   * case-blind disk are refused here, where every disk can see them.
   */
  it("never differ only in case where an import names them", () => {
    const files = execFileSync("git", ["ls-files"], { encoding: "utf8" })
      .split("\n")
      .filter((path) => MODULE.test(path));
    const seen = new Map<string, string>();
    const clashes: string[] = [];
    for (const path of files) {
      const stem = path.replace(MODULE, "");
      const held = seen.get(stem.toLowerCase());
      if (held !== undefined && held !== stem)
        clashes.push(`${held} <> ${stem}`);
      seen.set(stem.toLowerCase(), stem);
    }
    expect(files.length).toBeGreaterThan(500);
    expect(clashes).toEqual([]);
  });
});
