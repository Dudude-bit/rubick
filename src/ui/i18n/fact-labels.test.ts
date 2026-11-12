import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";

import { CODE_FILES } from "@/test/source-files";
import kinds from "../../contracts/kinds.json";
import { en } from "./catalogue";
import { ru } from "./ru";

/** Kind names stay Latin in every language, so a label that is one is not a missed translation. */
const kindWords = new Set([
  ...kinds.kinds.flatMap(({ kind }) => [kind, `${kind}s`]),
  "Middlewares",
]);

/** English column words the Russian catalogue translates, so a literal of one is a label left in English. */
const translated = new Set(
  Object.entries(en.columns)
    .filter(
      ([key, word]) =>
        typeof word === "string" &&
        word !== (ru.columns as Record<string, unknown>)[key]
    )
    .map(([, word]) => word as string)
);

function literalLabels(): string[] {
  return CODE_FILES.filter((path) => path.endsWith(".tsx")).flatMap((path) =>
    [
      ...readFileSync(path, "utf8").matchAll(
        /(?:\blabel:\s*|<KeyValueSection\s+title=)"([^"]+)"/g
      ),
    ]
      .filter((m) => translated.has(m[1]) && !kindWords.has(m[1]))
      .map((m) => `${path}: ${m[1]}`)
  );
}

describe("fact labels", () => {
  /** Breaks when a detail page writes "Volume" beside translated labels, as the PVC Claim card did while its list said "Том". */
  it("never spell a translated column word as an English literal", () => {
    expect(literalLabels()).toEqual([]);
  });

  /** Breaks when the set of translated words is empty and the guard above checks nothing. */
  it("knows the column words Russian translates", () => {
    expect(translated.has("Volume")).toBe(true);
    expect(translated.has("Claim")).toBe(true);
  });
});
