import { describe, expect, it } from "vitest";

const SOURCES = import.meta.glob<string>(
  ["./**/*.{ts,tsx}", "!./**/*.test.{ts,tsx}"],
  {
    query: "?raw",
    import: "default",
    eager: true,
  }
);

describe("how a vendor page says a read failed", () => {
  /**
   * Fifteen pages printed a query's `error.message` under a heading: the
   * Tauri command's name in front of the cluster's words, no retry, and no
   * rule for a refusal. `VendorReadFailure` (or `errorToShow` inline) is the
   * way; a sixteenth copy would bring the prefix back unnoticed.
   */
  it("never prints a query's raw error message", () => {
    const raw = Object.entries(SOURCES).flatMap(([path, source]) =>
      /\.error\.message\b/.test(source) ? [path] : []
    );
    expect(Object.keys(SOURCES).length).toBeGreaterThan(140);
    expect(raw).toEqual([]);
  });
});
