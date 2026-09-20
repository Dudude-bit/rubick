/**
 * "Can this container take an exec" is one judgement — `whyNoShell` — and
 * its doc comment says so. Three surfaces read it; the Checks tab was a
 * fourth that did not, so it offered a terminated container as though it
 * could answer a check and the run failed with the runtime's words instead
 * of ours.
 *
 * A source guard because the chooser is a Radix Select, whose popup does
 * not open under jsdom: what is checkable here is that the surface asks.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const READERS = [
  "src/components/terminal/PodShell.tsx",
  "src/components/checks/ChecksTab.tsx",
];

describe("who decides whether a container can take an exec", () => {
  it.each(READERS)("%s asks whyNoShell rather than the state", (path) => {
    expect(readFileSync(path, "utf8")).toContain("whyNoShell");
  });

  /** A guard that reads nothing passes forever. */
  it("reads files that really offer a container to exec into", () => {
    for (const path of READERS) {
      expect(readFileSync(path, "utf8")).toMatch(/container/i);
    }
  });
});
