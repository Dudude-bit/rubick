import { describe, expect, it } from "vite-plus/test";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import { formatLineRate, formatName } from "./types";

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
});
