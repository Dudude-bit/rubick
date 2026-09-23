import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import type {
  ConditionInfo,
  ParentRefInfo,
  RouteParentStatusInfo,
} from "@/generated/types";
import { saidOf, statusesFor, verdictOf, type Verdict } from "./route-verdict";

type ShortParent = Partial<ParentRefInfo> & { name: string };
interface Expected {
  state: Verdict["state"];
  reason?: string;
  observedGeneration?: number;
}
interface Case {
  name: string;
  routeNamespace: string;
  parent: ShortParent;
  entries: {
    parent: ShortParent;
    controllerName: string;
    conditions: Partial<ConditionInfo>[];
  }[];
  accepted: Expected;
  resolvedRefs: Expected;
}

const corpus = JSON.parse(
  readFileSync(
    resolve(process.cwd(), "shared/route-verdict-conformance.json"),
    "utf8"
  )
) as { cases: Case[] };

const parentOf = (short: ShortParent): ParentRefInfo => ({
  group: "gateway.networking.k8s.io",
  kind: "Gateway",
  namespace: null,
  sectionName: null,
  port: null,
  ...short,
});

const entryOf = (entry: Case["entries"][number]): RouteParentStatusInfo => ({
  parent: parentOf(entry.parent),
  controllerName: entry.controllerName,
  conditions: entry.conditions.map((c) => ({
    type: c.type ?? "",
    status: c.status ?? "",
    reason: c.reason ?? null,
    message: null,
    lastTransitionTime: null,
    ...(c.observedGeneration != null
      ? { observedGeneration: c.observedGeneration }
      : {}),
  })),
});

function answer(verdict: Verdict): Expected {
  const said = saidOf(verdict);
  return {
    state: verdict.state,
    ...(said?.reason ? { reason: said.reason } : {}),
    ...(said?.observedGeneration != null
      ? { observedGeneration: said.observedGeneration }
      : {}),
  };
}

const strip = (expected: Expected, got: Expected): Expected =>
  expected.observedGeneration == null
    ? { state: got.state, ...(got.reason ? { reason: got.reason } : {}) }
    : got;

describe("what a route's status says about one parent", () => {
  /**
   * The connections graph reads this in Rust and every page here reads it in
   * TypeScript. When the two drift, one screen draws a route refused and the
   * one beside it accepted; the corpus is what keeps them one answer.
   */
  it("reads as the shared corpus says, on this side too", () => {
    expect(corpus.cases.length).toBeGreaterThan(10);
    for (const c of corpus.cases) {
      const entries = statusesFor(
        { namespace: c.routeNamespace, parents: c.entries.map(entryOf) },
        parentOf(c.parent)
      );
      const accepted = answer(verdictOf(entries, "Accepted"));
      const refs = answer(verdictOf(entries, "ResolvedRefs"));
      expect(strip(c.accepted, accepted), c.name).toEqual(c.accepted);
      expect(strip(c.resolvedRefs, refs), c.name).toEqual(c.resolvedRefs);
    }
  });
});
