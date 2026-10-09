import { describe, expect, it } from "vite-plus/test";

const SOURCES = import.meta.glob<string>(
  [
    "/src/ui/**/*.{ts,tsx}",
    "!/src/ui/**/*.test.{ts,tsx}",
    "!/src/ui/generated/**",
  ],
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

describe("how a moment is put into words", () => {
  /**
   * `toLocaleString()` speaks the webview's language, not the one the
   * reader chose: a Russian window printed "Oct 4, 08:27 AM" and
   * "10/3/2026, 8:08:19 PM". Every moment goes through `formatWhen`.
   */
  it("never formats a date or number in the webview's language", () => {
    const offenders = Object.entries(SOURCES).flatMap(([path, source]) =>
      /\.toLocale(?:Date|Time)?String\(/.test(source) ? [path] : []
    );
    expect(offenders).toEqual([]);
  });

  /** A second formatter is a second set of rules for the same moment. */
  it("builds Intl date and unit formats in one module", () => {
    const offenders = Object.entries(SOURCES).flatMap(([path, source]) =>
      /new Intl\.(?:DateTimeFormat|NumberFormat|RelativeTimeFormat)\(/.test(
        source
      ) &&
      !path.endsWith("/lib/utils.ts") &&
      !path.endsWith("/cron-schedule.ts")
        ? [path]
        : []
    );
    expect(offenders).toEqual([]);
  });
});
