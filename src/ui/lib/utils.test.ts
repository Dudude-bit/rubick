import { describe, expect, it } from "vite-plus/test";

import {
  formatAge,
  formatDate,
  formatDuration,
  formatSince,
  formatTimeUnit,
  formatWhen,
} from "./utils";
import { loadLocale, translate } from "@/i18n";
import { useLocaleStore } from "@/stores/localeStore";
import type { T } from "@/i18n/useT";

const en: T = (section, key, values) => translate("en", section, key, values);
const ru: T = (section, key, values) => translate("ru", section, key, values);

/** Intl separates a number from its unit with a no-break space. */
const plain = (text: string) => text.replace(/\s/g, " ");

describe("formatAge", () => {
  /** English keeps `kubectl`'s `1h`; a Russian reader saw "13m назад", an
   *  English unit inside a Russian sentence. */
  it("prints kubectl's units in English and the reader's own in Russian", () => {
    const anHourAgo = new Date(Date.now() - 3600_000).toISOString();
    expect(formatAge(anHourAgo, en, "en")).toBe("1h");
    expect(plain(formatAge(anHourAgo, ru, "ru"))).toBe("1 ч");
  });

  /** The absence is a word, and a word has to be said in the reader's
   *  language. It returned the literal "Unknown" until 2026-08-30 — a bare
   *  word in a utility file, which is why every scan by sentence missed it. */
  it("says the absence in the reader's language", () => {
    expect(formatAge(null, en)).toBe("Unknown");
    expect(formatAge(null, ru)).toBe("Неизвестно");
    expect(formatAge("not a date", ru)).toBe("Неизвестно");
  });
});

describe("formatSince", () => {
  /** Each unit is a branch; deleting one prints the next smaller unit. */
  it("names the largest whole unit in either language", () => {
    const now = 10 * 86400_000;
    const cases: [number, string, string][] = [
      [56_000, "56s", "56 с"],
      [13 * 60_000, "13m", "13 мин"],
      [5 * 3600_000, "5h", "5 ч"],
      [4 * 86400_000, "4d", "4 д."],
    ];
    for (const [ago, english, russian] of cases) {
      expect(formatSince(now - ago, now, "en")).toBe(english);
      expect(plain(formatSince(now - ago, now, "ru"))).toBe(russian);
    }
  });

  /** "{age} назад" is the sentence; the age inside it has to be Russian too. */
  it("reads as a Russian sentence once put into one", () => {
    const age = formatSince(0, 13 * 60_000, "ru");
    expect(plain(translate("ru", "action", "agoSuffix", { age }))).toBe(
      "13 мин назад"
    );
  });
});

describe("the reader's language", () => {
  /** Most callers pass no language; they must get the one the reader chose. */
  it("is the one a caller gets without naming it", async () => {
    await loadLocale("ru");
    useLocaleStore.setState({ choice: "ru" });
    try {
      expect(plain(formatSince(0, 60_000))).toBe("1 мин");
      expect(plain(formatWhen(new Date(2020, 9, 4), "day"))).toBe(
        "4 окт. 2020 г."
      );
    } finally {
      useLocaleStore.setState({ choice: null });
    }
  });
});

describe("formatDuration", () => {
  /** A job that ran 2m 5s said "2m 5s" in a Russian table. */
  it("gives the two largest units in the reader's language", () => {
    expect(formatDuration(125, "en")).toBe("2m 5s");
    expect(plain(formatDuration(125, "ru"))).toBe("2 мин 5 с");
    expect(formatDuration(26 * 3600 + 60, "en")).toBe("1d 2h");
    expect(plain(formatDuration(26 * 3600 + 60, "ru"))).toBe("1 д. 2 ч");
  });

  /** A zero part is noise: five minutes flat is "5m", not "5m 0s". */
  it("drops a unit that is zero", () => {
    expect(formatDuration(300, "en")).toBe("5m");
    expect(formatDuration(0, "en")).toBe("0s");
    expect(plain(formatDuration(0, "ru"))).toBe("0 с");
  });

  /** "192ms, срезы по 100 ms" mixed two spellings of one unit. */
  it("spells milliseconds and fractions the way the language does", () => {
    expect(formatTimeUnit(192, "millisecond", "en")).toBe("192ms");
    expect(plain(formatTimeUnit(192, "millisecond", "ru"))).toBe("192 мс");
    expect(formatTimeUnit(1.53, "second", "en", 1)).toBe("1.5s");
    expect(plain(formatTimeUnit(1.53, "second", "ru", 1))).toBe("1,5 с");
  });
});

describe("formatWhen", () => {
  const thisYear = new Date().getFullYear();

  /** The Changes timeline read "Oct 4, 08:27 AM" to a Russian reader. */
  it("writes a moment in the reader's language", () => {
    const at = new Date(thisYear, 9, 4, 8, 27);
    expect(plain(formatWhen(at, "moment", "en"))).toBe("Oct 4, 08:27 AM");
    expect(plain(formatWhen(at, "moment", "ru"))).toBe("4 окт., 08:27");
  });

  /** Without the year, a release from three years ago looks like this week's. */
  it("adds the year to a moment only when it is not this one", () => {
    const at = new Date(thisYear - 3, 9, 4, 8, 27);
    expect(plain(formatWhen(at, "moment", "ru"))).toBe(
      `4 окт. ${thisYear - 3} г., 08:27`
    );
  });

  /** Helm's Updated column read "10/3/2026, 8:08:19 PM" in Russian. */
  it("writes a full stamp and a 24-hour clock in either language", () => {
    const at = new Date(2020, 9, 3, 20, 8, 19);
    expect(plain(formatWhen(at, "full", "en"))).toBe("Oct 3, 2020, 8:08:19 PM");
    expect(plain(formatWhen(at, "full", "ru"))).toBe(
      "3 окт. 2020 г., 20:08:19"
    );
    expect(formatWhen(at, "clock", "en")).toBe("20:08:19");
    expect(plain(formatDate(at.toISOString(), "ru") ?? "")).toBe(
      "3 окт. 2020 г., 20:08:19"
    );
  });

  /** What the cluster wrote is shown as written when it is not a date. */
  it("shows a value that is not a date as it was written", () => {
    expect(formatWhen("soon", "full", "ru")).toBe("soon");
    expect(formatDate("soon", "ru")).toBeNull();
  });
});
