import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { CODE_FILES } from "@/test/source-files";

describe("a count in words", () => {
  /**
   * `${n} path${n === 1 ? "" : "s"}` has no whole string for a scanner to
   * find, and Russian has three forms, so it survived every sweep: three
   * routing maps and the tool-path hint printed English on a Russian screen.
   */
  it("comes from a catalogue plural, never an English 's' added in code", () => {
    const composed = CODE_FILES.filter(
      (path) => !path.startsWith("src/i18n/")
    ).filter((path) =>
      /[=!]== 1 \? "s?" : "s?"|> 1 \? "s" : ""/.test(readFileSync(path, "utf8"))
    );
    expect(CODE_FILES.length).toBeGreaterThan(500);
    expect(composed).toEqual([]);
  });
});
