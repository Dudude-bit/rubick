import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { logsToText, type LogLine } from "./types";

interface Case {
  line: { raw: string; timestamp: string | null; message: string };
  text: string;
}

const corpus = JSON.parse(
  readFileSync(
    resolve(process.cwd(), "shared/log-text-conformance.json"),
    "utf8"
  )
) as { cases: Case[] };

describe("a log line as text", () => {
  /**
   * The Download button is written by the backend now and Copy still here.
   * If the two drifted, a saved log and a copied one would disagree about
   * the same line; the corpus is what keeps them one answer.
   */
  it("reads as the shared corpus says, on this side too", () => {
    expect(corpus.cases.length).toBeGreaterThan(0);
    for (const { line, text } of corpus.cases) {
      expect(logsToText([line as unknown as LogLine])).toBe(text);
    }
  });
});
