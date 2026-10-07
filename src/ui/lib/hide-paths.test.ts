import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vite-plus/test";

import type { PathIdentity } from "@/generated/types";
import { hidePath } from "./hide-paths";

const corpus = JSON.parse(
  readFileSync(
    resolve(process.cwd(), "src/contracts/path-redaction-conformance.json"),
    "utf8"
  )
) as { cases: { identity: PathIdentity; text: string; hidden: string }[] };

describe("a path from this computer with names and paths redacted", () => {
  /**
   * The copied report hides paths in Rust and every other screen here. If
   * the two drifted, a screenshot of the Helm page would name a home the
   * report beside it hides; the corpus keeps them one answer.
   */
  it("hides as the shared corpus says, on this side too", () => {
    expect(corpus.cases.length).toBeGreaterThan(0);
    for (const { identity, text, hidden } of corpus.cases)
      expect(hidePath(text, identity)).toBe(hidden);
  });
});
