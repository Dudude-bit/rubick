import { describe, expect, it } from "vitest";

import { formatAge } from "./utils";
import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";

const en: T = (section, key, values) => translate("en", section, key, values);
const ru: T = (section, key, values) => translate("ru", section, key, values);

describe("formatAge", () => {
  /** `d`/`h`/`m`/`s` are `kubectl`'s notation, and the reader is matching
   *  this against a terminal. Translating them would break the comparison
   *  the compact form exists for. */
  it("keeps the units the cluster's own tooling prints", () => {
    const anHourAgo = new Date(Date.now() - 3600_000).toISOString();
    expect(formatAge(anHourAgo, en)).toBe("1h");
    expect(formatAge(anHourAgo, ru)).toBe("1h");
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
