/**
 * The stream is stopped by the query's abort signal, and `pod-rows.test.ts`
 * holds that `listPodRows` honours one. Nothing held that anyone passes one:
 * dropping `signal` from both call sites left the whole suite green, and
 * with it a pod list that keeps streaming pages at a screen the reader has
 * already left — which on the cluster sizes this was written for is the
 * cost the PR exists to remove.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const CALLERS = [
  "src/hooks/usePodsWithMetrics.ts",
  "src/hooks/usePrefetchCoreLists.ts",
];

describe("who hands the pod stream a way to stop", () => {
  it.each(CALLERS)("%s passes the query's signal", (path) => {
    const source = readFileSync(path, "utf8");
    const call = /listPodRows\(([^)]*)\)/.exec(source);
    expect(call, `${path} no longer calls listPodRows`).not.toBeNull();
    expect(call![1]).toMatch(/\bsignal\b/);
  });

  /** A guard that reads nothing passes forever. */
  it("reads files that really do call it", () => {
    for (const path of CALLERS) {
      expect(readFileSync(path, "utf8")).toContain("listPodRows");
    }
  });
});
