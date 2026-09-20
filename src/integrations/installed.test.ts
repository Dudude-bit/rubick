/**
 * "Is this vendor here" has three answers, and the Integrations pane had
 * two. `found` is `null` when the detection scan could not look — a refused
 * CRD list — and folding that into "not installed" states an absence about
 * the one cluster where nobody checked, two clicks from the vendor's own
 * page saying otherwise.
 */

import { describe, expect, it } from "vitest";

import { isInstalled } from "./index";

describe("whether a vendor is here", () => {
  it("does not call a scan that could not look an absence", () => {
    expect(isInstalled(null, false, true)).toBeNull();
    expect(isInstalled(null, false, false)).toBeNull();
  });

  it("is settled by an address that answers, whatever the scan saw", () => {
    expect(isInstalled(null, true, true)).toBe(true);
    expect(isInstalled(false, true, true)).toBe(true);
  });

  it("still says absent when the scan really looked and found nothing", () => {
    expect(isInstalled(false, false, true)).toBe(false);
    expect(isInstalled(false, false, false)).toBe(false);
  });

  it("still says present when the scan found the kinds", () => {
    expect(isInstalled(true, false, false)).toBe(true);
  });
});
