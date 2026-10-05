import { readFileSync } from "node:fs";
import { parseSync } from "vite-plus";
import { describe, expect, it } from "vite-plus/test";

import { CODE_FILES } from "@/test/source-files";
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

/** Each line of a file that holds a dash anywhere but in a comment, as `path:line`. */
function dashedLines(path: string, source: string): string[] {
  if (!DASH.test(source)) return [];
  const code = source.split("");
  for (const comment of parseSync(path, source).comments)
    for (let i = comment.start; i < comment.end; i++)
      if (code[i] !== "\n") code[i] = " ";
  return code
    .join("")
    .split("\n")
    .flatMap((line, index) =>
      DASH.test(line) ? [`${path}:${index + 1}`] : []
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

  /**
   * The catalogues were clean while the code around them still drew "—" for
   * every empty cell and glued labels with " — ". Fails on a dash in any JSX
   * text, attribute, string, template or regex under src/ui; comments may
   * keep theirs, and a pattern that has to match one spells it —.
   */
  it("keeps every em and en dash out of what the UI code draws", () => {
    const dashed = CODE_FILES.filter(
      (path) => !path.startsWith("src/ui/generated/")
    ).flatMap((path) => dashedLines(path, readFileSync(path, "utf8")));
    expect(dashed).toEqual([]);
  });

  /** The scan itself: a dash in a comment is skipped, one in drawn text is not. */
  it("tells a dash in drawn text from one in a comment", () => {
    const source = [
      "// a comment — fine",
      "/** a doc — fine */",
      'const empty = "—";',
      "const Row = () => <p>a – b {/* note — fine */}</p>;",
    ].join("\n");
    expect(dashedLines("x.tsx", source)).toEqual(["x.tsx:3", "x.tsx:4"]);
  });
});
