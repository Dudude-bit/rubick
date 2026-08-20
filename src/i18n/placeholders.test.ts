import { describe, expect, it } from "vitest";

import { en, type Plural } from "./catalogue";
import { ru } from "./ru";

const CATALOGUES = { en, ru };

/** A plural's forms, minus the ones this language does not use. */
type Forms = Array<[string, string]>;

/** Every `{name}` a string asks its caller to supply. */
function slots(text: string): Set<string> {
  return new Set([...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]));
}

function formsOf(plural: Plural): Forms {
  return Object.entries(plural).filter(
    (entry): entry is [string, string] => entry[1] !== undefined
  );
}

function sections(catalogue: object): Array<[string, string, string | Plural]> {
  return Object.entries(catalogue).flatMap(([section, keys]) =>
    Object.entries(keys as Record<string, string | Plural>).map(
      ([key, value]) =>
        [section, key, value] as [string, string, string | Plural]
    )
  );
}

/** Every string in the catalogue, plurals unrolled one form per entry. */
function strings(catalogue: object): Forms {
  return sections(catalogue).flatMap(([section, key, value]) =>
    typeof value === "string"
      ? [[`${section}.${key}`, value] as [string, string]]
      : formsOf(value).map(
          ([form, text]) =>
            [`${section}.${key}.${form}`, text] as [string, string]
        )
  );
}

/** How many counts in 0..200 this locale routes to this plural form. */
function countsRoutedTo(locale: string, form: string): number {
  const rules = new Intl.PluralRules(locale);
  let n = 0;
  for (let count = 0; count <= 200; count++)
    if (rules.select(count) === form) n += 1;
  return n;
}

/**
 * A placeholder is a contract between a string and its caller that the type
 * system does not check: `t("action", "valueCopied")` with no values compiles
 * and puts the literal text `Value of {label} copied.` on somebody's screen.
 * Three of those shipped before this test existed.
 */
describe("what a string asks its caller for", () => {
  it("is the same in both languages", () => {
    const russian = new Map(strings(ru));
    // `n` is left to the test below: English may legitimately spell it out.
    const named = (text: string) =>
      [...slots(text)].filter((s) => s !== "n").sort();
    const differ = strings(en).flatMap(([id, text]) => {
      const other = russian.get(id);
      if (other === undefined) return [];
      const [a, b] = [named(text), named(other)];
      return a.join() === b.join() ? [] : [`${id}: en {${a}} vs ru {${b}}`];
    });
    expect(differ).toEqual([]);
  });

  /**
   * A plural form may leave the count out only when it stands for exactly one
   * number, which is what lets English write "This row stands". Russian `one`
   * also covers 21, 31 and 41, so the same omission there loses the count and
   * puts a singular verb next to twenty-one things.
   */
  it("keeps the count in every form that stands for more than one number", () => {
    const missing: string[] = [];
    for (const [locale, catalogue] of Object.entries(CATALOGUES))
      for (const [section, key, value] of sections(catalogue)) {
        if (typeof value === "string") continue;
        const forms = formsOf(value);
        if (!forms.some(([, text]) => slots(text).has("n"))) continue;
        for (const [form, text] of forms)
          if (!slots(text).has("n") && countsRoutedTo(locale, form) > 1)
            missing.push(`${locale}.${section}.${key}.${form}`);
      }
    expect(missing).toEqual([]);
  });
});
