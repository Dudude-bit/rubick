import { describe, expect, it } from "vitest";

import { en } from "@/i18n/catalogue";
import { ru } from "@/i18n/ru";

/**
 * The four verdicts the coverage page draws on an endpoint row, in every
 * language it ships. They are not shades of one another: "covered" and
 * "nothing selects it" are opposite answers about the same endpoint, and
 * the Russian side gave both of the latter pair the same words as
 * `rowSelectsNothing` — "selects nothing", a claim about the endpoint that
 * an endpoint cannot make, printed where the verdict says the endpoint is
 * unrestricted.
 */
describe("the words the coverage verdict is drawn with", () => {
  const keys = [
    "ciliumCovered",
    "ciliumUnrestricted",
    "ciliumOnlyRejected",
    "ciliumCannotSay",
  ] as const;

  for (const [language, strings] of Object.entries({ en, ru })) {
    it(`tells the four verdicts apart in ${language}`, () => {
      const readings = (
        strings as unknown as Record<string, Record<string, string>>
      ).readings;
      const said = keys.map((key) => readings[key]);
      expect(said.filter(Boolean)).toHaveLength(keys.length);
      expect(new Set(said).size).toBe(keys.length);
    });
  }

  /**
   * And the pairing that caused it: the verdict about what selects the
   * endpoint must not read as the row's own "selects nothing".
   */
  for (const [language, strings] of Object.entries({ en, ru })) {
    it(`does not reuse the row's selects-nothing wording in ${language}`, () => {
      const all = strings as unknown as Record<string, Record<string, string>>;
      const unrestricted = all.readings?.ciliumUnrestricted;
      const selectsNothing = all.monitors?.rowSelectsNothing;
      if (!unrestricted || !selectsNothing) return;
      expect(unrestricted).not.toBe(selectsNothing);
    });
  }
});
