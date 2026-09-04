import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { manifestPodStatus } from "./utils";
import type { ManifestStatus } from "./types";

/**
 * The status kubectl prints, derived twice.
 *
 * Rust derives it for every live pod; this module derives it for a manifest
 * pasted into the builder, where no cluster read happened and `.status.phase`
 * says Running for a pod that has crashed six hundred times. Two evaluators
 * for one question is a standing invitation to drift — the Rust one walks the
 * container list backwards so the first container's verdict stands, and
 * nothing but this file says the TypeScript one has to agree.
 *
 * Its twin is `pod_display.rs`'s `the_shared_corpus_says_what_this_says`.
 */
const corpus = JSON.parse(
  // Read rather than imported: the same bytes `include_str!` pulls into the
  // Rust test, with no bundler in between to reformat them.
  readFileSync(
    resolve(process.cwd(), "shared/pod-status-conformance.json"),
    "utf8"
  )
) as {
  cases: Array<{ name: string; status: ManifestStatus; expect: string }>;
};

describe("the status both evaluators derive", () => {
  it.each(corpus.cases.map((c) => [c.name, c] as const))(
    "%s",
    (_name, testCase) => {
      expect(manifestPodStatus(testCase.status)).toBe(testCase.expect);
    }
  );

  /** A corpus nobody added to is a contract nobody is held to. */
  it("holds every case the file states", () => {
    expect(corpus.cases.length).toBeGreaterThanOrEqual(6);
  });
});
