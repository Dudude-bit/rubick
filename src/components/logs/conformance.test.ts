import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";

import type { LogLevel, QueryTerm } from "@/generated/types";
import { LEVEL_RANK, matchesQuery, type StreamedLogLine } from "./types";

/**
 * The viewer's half of the intake contract.
 *
 * `QueryTerm` is generated from Rust, so the two sides cannot disagree
 * about a term's *shape*. They can still disagree about which lines it
 * selects, and that is the failure that matters: a chip promoted from
 * query to intake moves from this evaluator to the streamer's, and a
 * disagreement would show up as a chip quietly meaning something else
 * once it turned blue. Both evaluators are held to the same corpus —
 * `logs::filter::tests::every_term_shape_selects_what_the_viewer_selects`
 * is this test in Rust.
 */
const corpus = JSON.parse(
  // Read rather than imported: the same bytes `include_str!` pulls into
  // the Rust test, with no bundler in between to reformat them.
  readFileSync(
    resolve(process.cwd(), "shared/log-query-conformance.json"),
    "utf8"
  )
) as {
  levelOrder: LogLevel[];
  cases: Array<{
    name: string;
    term: QueryTerm;
    line: {
      message?: string;
      raw?: string;
      level?: LogLevel;
      fields?: Record<string, string>;
      container?: string;
    };
    epoch?: number;
    expect: boolean;
  }>;
};

/** The gaps the Rust reader fills the same way. */
function build(
  partial: (typeof corpus.cases)[number]["line"],
  epoch: number
): StreamedLogLine {
  return {
    id: 0,
    epoch,
    groupKey: "",
    timestamp: null,
    message: partial.message ?? "",
    raw: partial.raw ?? "",
    level: partial.level ?? null,
    fields: partial.fields ?? null,
    format: "plain",
    pod: "pod",
    container: partial.container ?? "app",
    namespace: "default",
  };
}

describe("query and intake select the same lines", () => {
  it("has cases to check", () => {
    expect(corpus.cases.length).toBeGreaterThan(20);
  });

  for (const testCase of corpus.cases) {
    it(testCase.name, () => {
      const log = build(testCase.line, testCase.epoch ?? 0);
      expect(matchesQuery(log, [testCase.term])).toBe(testCase.expect);
    });
  }

  it("ranks severity the way the streamer does", () => {
    expect(corpus.levelOrder.map((level) => LEVEL_RANK[level])).toEqual(
      corpus.levelOrder.map((_, index) => index)
    );
    expect(Object.keys(LEVEL_RANK).sort()).toEqual(
      [...corpus.levelOrder].sort()
    );
  });
});
