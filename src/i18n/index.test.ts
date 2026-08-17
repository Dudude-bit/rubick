import { describe, expect, it } from "vitest";

import { en, type Plural } from "./catalogue";
import { ru } from "./ru";
import { isTranslated, localeFrom, LOCALES, translate } from "./index";

describe("looking a string up", () => {
  it("gives English when English is asked for", () => {
    expect(translate("en", "action", "cancel")).toBe("Cancel");
  });

  it("gives the translation when there is one", () => {
    expect(translate("ru", "action", "cancel")).toBe("Отмена");
  });

  /**
   * Per key, not per language. A contributor who translates half a file
   * should see their half, not have the whole language refused — and the
   * English remainder is what shows them where to keep going.
   */
  it("falls back to English for a key a language has not reached", () => {
    expect(translate("de", "action", "cancel")).toBe("Cancel");
  });

  it("leaves a placeholder alone when nothing was given for it", () => {
    expect(translate("en", "activity", "active")).toBe("{n} active");
  });
});

describe("counting things", () => {
  /**
   * The reason there is no `n === 1 ? x : y` anywhere in this app. Russian
   * needs three forms and picks between them by the number's last digits:
   * 1 проброс, 2 проброса, 5 пробросов, and then 21 проброс again.
   */
  it("picks the Russian form the number actually calls for", () => {
    const say = (n: number) =>
      translate("ru", "activity", "portForwards", { n });
    expect(say(1)).toBe("1 проброс");
    expect(say(2)).toBe("2 проброса");
    expect(say(5)).toBe("5 пробросов");
    expect(say(21)).toBe("21 проброс");
    expect(say(11)).toBe("11 пробросов");
  });

  it("still has only the two English forms", () => {
    const say = (n: number) =>
      translate("en", "activity", "portForwards", { n });
    expect(say(1)).toBe("1 port forward");
    expect(say(2)).toBe("2 port forwards");
    expect(say(21)).toBe("21 port forwards");
  });

  /** Zero is `other` in both, and neither language wants a special case. */
  it("counts none of something without a special case", () => {
    expect(translate("en", "cluster", "podCount", { n: 0 })).toBe("0 pods");
    expect(translate("ru", "cluster", "podCount", { n: 0 })).toBe("0 подов");
  });
});

describe("choosing a language from the system", () => {
  it("matches on the language, not the region", () => {
    expect(localeFrom("ru-RU")).toBe("ru");
    expect(localeFrom("ru_KZ")).toBe("ru");
    expect(localeFrom("de")).toBe("de");
  });

  it("falls back to English for anything unoffered or absent", () => {
    expect(localeFrom("ja-JP")).toBe("en");
    expect(localeFrom(undefined)).toBe("en");
    expect(localeFrom("")).toBe("en");
  });
});

describe("the catalogue itself", () => {
  /**
   * The guarantee the `Catalogue` type is there to make. It is checked at
   * build time, but a test says so out loud for anyone adding a language.
   */
  it("has a Russian entry for every English one", () => {
    for (const section of Object.keys(en) as Array<keyof typeof en>) {
      for (const key of Object.keys(en[section])) {
        expect(
          (ru as Record<string, Record<string, unknown>>)[section][key],
          `ru.${section}.${key} is missing`
        ).toBeDefined();
      }
    }
  });

  /** Every plural must have `other`, because it is what the fallback uses. */
  it("gives every counted string an `other` form in both languages", () => {
    const catalogues: Array<Record<string, Record<string, string | Plural>>> = [
      en,
      ru,
    ];
    for (const catalogue of catalogues) {
      for (const section of Object.values(catalogue)) {
        for (const entry of Object.values(section)) {
          if (typeof entry !== "string") {
            expect(entry.other).toBeTruthy();
          }
        }
      }
    }
  });

  it("offers a language nobody has filled in, and says so", () => {
    expect(LOCALES).toContain("de");
    expect(isTranslated("ru")).toBe(true);
    expect(isTranslated("de")).toBe(false);
  });
});
