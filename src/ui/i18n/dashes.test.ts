import { describe, expect, it } from "vite-plus/test";

import { en, type Plural } from "./catalogue";
import { ru } from "./ru";

const DASH = /[—–]/;

/** Every string a catalogue holds, each plural form on its own, by its path. */
function strings(catalogue: object): Array<[string, string]> {
  return Object.entries(catalogue).flatMap(([section, keys]) =>
    Object.entries(keys as Record<string, string | Plural>).flatMap(
      ([key, value]): Array<[string, string]> =>
        typeof value === "string"
          ? [[`${section}.${key}`, value]]
          : Object.entries(value).map(([form, text]) => [
              `${section}.${key}.${form}`,
              String(text),
            ])
    )
  );
}

describe("the punctuation of the copy", () => {
  /** An em or en dash pasted into a string reaches the screen, and no other test, lint rule or scanner looks for one. */
  it.each([
    ["en", en],
    ["ru", ru],
  ])("keeps every %s string free of em and en dashes", (_locale, catalogue) => {
    const dashed = strings(catalogue)
      .filter(([, text]) => DASH.test(text))
      .map(([id]) => id);
    expect(dashed).toEqual([]);
  });
});
