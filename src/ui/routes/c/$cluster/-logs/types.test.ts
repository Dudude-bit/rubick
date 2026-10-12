import { describe, expect, it } from "vite-plus/test";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import { formatLineRate, formatName, lineRateValues } from "./types";

const ru: T = (section, key, values) => translate("ru", section, key, values);

describe("the logs footer", () => {
  /**
   * Lena's Russian footer read "plain · 0.2 строк/с": an English word and a
   * decimal point where the Overview writes "0,5". Fails if plain text keeps
   * its English name, a format's own name is translated, or the rate ignores
   * the reader's decimal mark.
   */
  it("names plain text in the reader's language and writes the rate with their decimal mark", () => {
    expect(formatName("plain", ru)).toBe("обычный текст");
    expect(formatName("json", ru)).toBe("json");
    expect(formatLineRate(0.2, "ru")).toBe("0,2");
    expect(formatLineRate(0.2, "en")).toBe("0.2");
    expect(formatLineRate(12.6, "ru")).toBe("13");
  });

  /**
   * Lena's footer read "102 строк/с", the form for 5, not for 102. Fails if
   * the rate stops picking its plural by the number it shows.
   */
  it("words the rate in the form its shown number takes", () => {
    const rate = (n: number) =>
      translate("ru", "count", "linesPerSecond", lineRateValues(n, "ru"));
    expect(rate(102)).toBe("102 строки/с");
    expect(rate(1)).toBe("1 строка/с");
    expect(rate(5)).toBe("5 строк/с");
    expect(rate(2.5)).toBe("2,5 строки/с");
    expect(
      translate("en", "count", "linesPerSecond", lineRateValues(1, "en"))
    ).toBe("1 line/s");
  });

  /**
   * Lena could check the rate's plural live only on fractions: no logger in
   * the cluster wrote whole numbers of lines a second. Fails if a whole rate
   * takes the wrong form for its number in either language.
   */
  it("words whole rates in the form each number takes, in both languages", () => {
    const rate = (locale: "en" | "ru", n: number) =>
      translate(locale, "count", "linesPerSecond", lineRateValues(n, locale));
    expect([1, 2, 5, 21, 102].map((n) => rate("ru", n))).toEqual([
      "1 строка/с",
      "2 строки/с",
      "5 строк/с",
      "21 строка/с",
      "102 строки/с",
    ]);
    expect([1, 2, 5, 21, 102].map((n) => rate("en", n))).toEqual([
      "1 line/s",
      "2 lines/s",
      "5 lines/s",
      "21 lines/s",
      "102 lines/s",
    ]);
  });
});
