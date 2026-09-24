import { describe, expect, it } from "vitest";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import {
  applicationsNeedAttention,
  hostsBrokenOfTotal,
  hostsNeedAttention,
  valuesCopiedWithBinary,
} from "./two-counts";

const inLanguage =
  (language: "en" | "ru"): T =>
  (section, key, values) =>
    translate(language, section, key, values);
const ru = inLanguage("ru");
const en = inLanguage("en");

/** The second count wore the first one's form: "1 из 1 хостов",
 *  "1 of 5 host needs attention", "1 двоичных". */
describe("a sentence with two counts", () => {
  it("declines each count by its own number", () => {
    expect(hostsNeedAttention(1, 1, ru)).toBe("1 из 1 хоста требует внимания");
    expect(hostsNeedAttention(2, 5, ru)).toBe("2 из 5 хостов требуют внимания");
    expect(hostsNeedAttention(1, 5, en)).toBe("1 of 5 hosts needs attention");
    expect(hostsBrokenOfTotal(1, 1, ru)).toBe("1 из 1 хоста сломан");
    expect(applicationsNeedAttention(1, 1, en)).toBe(
      "1 of 1 application needs attention"
    );
    expect(applicationsNeedAttention(3, 21, ru)).toBe(
      "3 из 21 приложения требуют внимания"
    );
    expect(valuesCopiedWithBinary(5, 1, ru)).toBe(
      "Скопировано 5 значений, 1 двоичное — в base64."
    );
  });
});
