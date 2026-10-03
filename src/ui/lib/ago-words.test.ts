import { describe, expect, it } from "vitest";

const SOURCES = import.meta.glob<string>(
  ["/src/**/*.{ts,tsx}", "!/src/**/*.test.{ts,tsx}", "!/src/generated/**"],
  { query: "?raw", import: "default", eager: true }
);

describe("how an age is put into words", () => {
  /**
   * Four copies built `${n}m ago` in code, in English, and fed it to
   * sentences that were then translated around it: "проверено для вас,
   * 5m ago". An age is `formatSince`; "ago" belongs to the sentence.
   */
  it("never composes an English 'ago' in code", () => {
    const composed = Object.entries(SOURCES).flatMap(([path, source]) =>
      /\}[smhd] ago`/.test(source) ? [path] : []
    );
    expect(Object.keys(SOURCES).length).toBeGreaterThan(500);
    expect(composed).toEqual([]);
  });
});
