import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";

const css = readFileSync("src/ui/index.css", "utf8");

describe("the app's typography", () => {
  /**
   * Inter's contextual alternates drew the pod checkout-api-649f5449-h6x2v
   * as "h6×2v", a name nobody can find by typing what they read. Fails if
   * the body turns them back on, or any rule enables them again.
   */
  it("never redraws the characters of a name", () => {
    const body = /\bbody\s*\{[^}]*\}/.exec(css)?.[0] ?? "";
    expect(body).toMatch(/"calt"\s+0/);
    expect(css).not.toMatch(
      /"calt"\s+1|"calt"\s*[,;]|font-variant-ligatures:\s*contextual/
    );
  });
});
