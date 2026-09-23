import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { labelSelectorMatches, type LabelSelector } from "./label-selector";

interface Case {
  name: string;
  selector: LabelSelector;
  labels: Record<string, string>;
  matches: boolean | null;
}

const corpus = JSON.parse(
  readFileSync(
    resolve(process.cwd(), "shared/label-selector-conformance.json"),
    "utf8"
  )
) as { cases: Case[] };

describe("one label selector on both sides of the IPC boundary", () => {
  /**
   * Three evaluators gave three answers for `NotIn ()`: Rust said no, the
   * Prometheus and Cilium pages said yes to every object. The corpus is the
   * answer both halves owe; a case that drifts here drifts from Rust too.
   */
  it("answers every case in the shared corpus as the backend does", () => {
    for (const { name, selector, labels, matches } of corpus.cases) {
      expect(labelSelectorMatches(selector, labels), name).toBe(matches);
      expect(
        labelSelectorMatches(selector, new Map(Object.entries(labels))),
        name
      ).toBe(matches);
    }
  });

  /**
   * The corpus exists to pin the third answer; a corpus with no `null` in
   * it would pass an evaluator that had forgotten how to give one.
   */
  it("holds cases of every answer, for every operator", () => {
    const answers = new Set(corpus.cases.map((c) => c.matches));
    expect(answers).toEqual(new Set([true, false, null]));
    for (const operator of ["In", "NotIn", "Exists", "DoesNotExist"]) {
      const using = corpus.cases.filter((c) =>
        c.selector.matchExpressions?.some?.((e) => e.operator === operator)
      );
      expect(new Set(using.map((c) => c.matches)), operator).toEqual(
        new Set([true, false, null])
      );
    }
  });

  /**
   * A label called `constructor` or `toString` is one no object carries;
   * reading the record with `labels[key]` found the prototype's and said
   * `Exists` held.
   */
  it("does not read a key off the prototype of a label record", () => {
    expect(
      labelSelectorMatches(
        { matchExpressions: [{ key: "constructor", operator: "Exists" }] },
        {}
      )
    ).toBe(false);
  });

  /**
   * `LabelSelectorAsSelector(nil)` is `labels.Nothing()`. A missing
   * selector read as the empty one would select every object in scope.
   */
  it("matches nothing with a selector that is not there", () => {
    expect(labelSelectorMatches(null, { app: "shop" })).toBe(false);
    expect(labelSelectorMatches(undefined, {})).toBe(false);
  });
});
