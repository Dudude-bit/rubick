import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";

import type { ContainerRestarts, EventInfo } from "@/generated/types";
import { PROBE_WINDOW_MINUTES, probeFailure } from "./probe-failure";

const corpus = JSON.parse(
  readFileSync("src/contracts/probe-failure-conformance.json", "utf8")
) as {
  windowMinutes: number;
  cases: Array<{
    name: string;
    now: string;
    containers: ContainerRestarts[];
    events: Array<Partial<EventInfo>>;
    is: unknown;
  }>;
};

const event = (part: Partial<EventInfo>): EventInfo => ({
  name: "e",
  namespace: "ns",
  uid: "u",
  type: part.type ?? "",
  reason: part.reason ?? null,
  message: part.message ?? null,
  source: "kubelet",
  involvedObject: { kind: "Pod", name: "p", namespace: "ns", uid: null },
  count: null,
  firstTimestamp: part.firstTimestamp ?? null,
  lastTimestamp: part.lastTimestamp ?? null,
});

describe("a pod's failing probe, as both halves read it", () => {
  /** Fails when the window here and the one Rust applies drift apart. */
  it("keeps the window the shared file names", () => {
    expect(PROBE_WINDOW_MINUTES).toBe(corpus.windowMinutes);
  });

  /** Fails when a case reads differently on the page than on the Overview and the list. */
  it.each(corpus.cases.map((c) => [c.name, c] as const))("%s", (_, c) => {
    expect(
      probeFailure(c.containers, c.events.map(event), Date.parse(c.now))
    ).toEqual(c.is);
  });

  /** Fails if an events list that was not read is taken for one that says nothing failed. */
  it("says nothing when the events were not read", () => {
    expect(
      probeFailure([{ container: "app", n: 3 }], undefined, Date.now())
    ).toBeNull();
  });
});
