/**
 * The whole translation runtime.
 *
 * No library. What the interface needs is interpolation and plurals, and the
 * platform already ships the hard half: `Intl.PluralRules` knows every
 * language's categories, including the three Russian forms and the four Polish
 * ones, which is the part nobody should be hand-writing. The rest is a lookup
 * and a replace.
 *
 * What a library would have added is extraction tooling and runtime warnings
 * for missing keys. Typing `ru.ts` as `Catalogue` buys the second one at
 * compile time instead, which is strictly better: a missing key stops the
 * build rather than appearing on a screen.
 *
 * @module i18n
 */

import { en, type Catalogue, type Plural } from "./catalogue";
import { ru } from "./ru";

/**
 * The languages the interface is offered in.
 *
 * `en` and `ru` are filled. The other four are declared and deliberately
 * absent: the scaffolding, the plural handling and the language picker are
 * done, so contributing a language is one file and no code. A locale with no
 * catalogue falls back to English per key rather than being hidden, because a
 * half-translated interface is still more useful than an untranslatable one.
 */
export const LOCALES = ["en", "ru", "de", "fr", "es", "zh"] as const;
export type Locale = (typeof LOCALES)[number];

/** What each language calls itself, which is what a language picker must show. */
export const LOCALE_NAMES: Record<Locale, string> = {
  en: "English",
  ru: "Русский",
  de: "Deutsch",
  fr: "Français",
  es: "Español",
  zh: "中文",
};

const CATALOGUES: Partial<Record<Locale, Catalogue>> = { ru };

type Section = keyof typeof en;
type KeyOf<S extends Section> = keyof (typeof en)[S];

function isPlural(value: string | Plural): value is Plural {
  return typeof value !== "string";
}

/**
 * The form a language uses for this number.
 *
 * `Intl.PluralRules` returns the category name — `one`, `few`, `many`,
 * `other` — and the catalogue supplies the string for it. A language that
 * declares no form for the category it selected falls back to `other`, which
 * every entry is required to have.
 */
function pluralForm(entry: Plural, locale: Locale, n: number): string {
  const category = new Intl.PluralRules(locale).select(n);
  return entry[category] ?? entry.other;
}

/** `{n}` and friends, replaced. Missing values are left visible, not blanked. */
function fill(template: string, values?: Record<string, string | number>) {
  if (!values) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in values ? String(values[name]) : whole
  );
}

/**
 * Look one string up.
 *
 * Falls back to English per key rather than per language, so a partial
 * translation shows its translated half and the English rest instead of
 * refusing to render.
 */
export function translate<S extends Section>(
  locale: Locale,
  section: S,
  key: KeyOf<S>,
  values?: Record<string, string | number>
): string {
  const catalogue = CATALOGUES[locale];
  const entry =
    (catalogue?.[section] as Record<string, string | Plural> | undefined)?.[
      key as string
    ] ??
    ((en[section] as Record<string, string | Plural>)[key as string] as
      string | Plural);

  if (isPlural(entry)) {
    const n = Number(values?.n ?? 0);
    return fill(pluralForm(entry, locale, n), values);
  }
  return fill(entry, values);
}

/** Whether this locale has a catalogue at all, for the picker to say so. */
export function isTranslated(locale: Locale): boolean {
  return locale === "en" || locale in CATALOGUES;
}

/**
 * The best locale for a system language string like `ru-RU` or `de`.
 *
 * Matches on the language subtag only: a Russian speaker in Kazakhstan gets
 * Russian, and nobody is asked to maintain `ru-RU` and `ru-KZ` separately.
 */
export function localeFrom(systemLanguage: string | undefined): Locale {
  const tag = (systemLanguage ?? "").toLowerCase().split(/[-_]/)[0];
  return (LOCALES as readonly string[]).includes(tag) ? (tag as Locale) : "en";
}
