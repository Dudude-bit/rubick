import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vite-plus/test";

import {
  labelSelectorMatches,
  selectorFromQuery,
  type LabelSelector,
} from "./label-selector";

interface Case {
  name: string;
  selector: LabelSelector;
  labels: Record<string, string>;
  matches: boolean | null;
  query?: string;
}

const corpus = JSON.parse(
  readFileSync(
    resolve(process.cwd(), "src/contracts/label-selector-conformance.json"),
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

describe("a selector read back from the text the backend writes", () => {
  /**
   * NetworkPolicy selectors cross the boundary as query text. A parser that
   * drifted from `Selector::query_text` would match pods the policy never
   * names, and nothing else compares the two.
   */
  it("answers every corpus case from its query text as from the selector", () => {
    const written = corpus.cases.filter((c) => c.query !== undefined);
    expect(written.length).toBeGreaterThan(20);
    for (const { name, query, labels, matches } of written) {
      const selector = selectorFromQuery(query!);
      expect(selector, name).not.toBeNull();
      expect(labelSelectorMatches(selector, labels), name).toBe(matches);
    }
  });

  /** Text that is not the backend's form is not guessed at. */
  it("refuses text it cannot read as a selector", () => {
    expect(selectorFromQuery("app in (a")).toBeNull();
    expect(selectorFromQuery("app=a,,tier=b")).toBeNull();
    expect(selectorFromQuery("app >= 2")).toBeNull();
    expect(
      labelSelectorMatches(selectorFromQuery("app in ()")!, { app: "x" })
    ).toBeNull();
  });

  /** `key!=value` is kubectl's spelling of NotIn, absent key included. */
  it("reads inequality as NotIn", () => {
    const selector = selectorFromQuery("tier!=web")!;
    expect(labelSelectorMatches(selector, { tier: "api" })).toBe(true);
    expect(labelSelectorMatches(selector, {})).toBe(true);
    expect(labelSelectorMatches(selector, { tier: "web" })).toBe(false);
  });
});
