import { describe, expect, it } from "vitest";

import { drawnSeparately } from "./printer-columns";

describe("the printer columns the list draws itself", () => {
  /**
   * A CRD names its own printer columns. `kubectl`'s upper case is a
   * convention — Cilium writes `Age`, cert-manager writes `Age`, and a
   * case-sensitive check let both through, so every one of their kinds drew
   * two Age columns with the CRD's empty one beside ours. Fails if the
   * comparison stops folding case.
   */
  it("recognises a heading whatever case the CRD wrote it in", () => {
    for (const spelling of ["AGE", "Age", "age", " Age "]) {
      expect(drawnSeparately(spelling)).toBe(true);
    }
    for (const spelling of ["NAME", "Name", "name"]) {
      expect(drawnSeparately(spelling)).toBe(true);
    }
  });

  /** And claims nothing else: a column named after the object's own data stays. */
  it("leaves every other column to the CRD", () => {
    for (const other of ["CiliumInternalIP", "Ready", "Namespace", "Valid"]) {
      expect(drawnSeparately(other)).toBe(false);
    }
  });
});
