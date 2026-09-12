import { describe, expect, it } from "vitest";

/**
 * Every vendor module, loaded the way the registry loads them — by glob, so a
 * vendor nobody remembered to mention is still weighed. Same reason as
 * `vendor-copy.test.ts`, which this sits beside.
 */
const MODULES = import.meta.glob<Record<string, unknown>>("./*/index.ts", {
  eager: true,
});

interface Weighed {
  id: string;
  crd?: unknown;
  page?: { gate?: { crd: string | readonly string[] } | null };
}

function vendorsIn(module: Record<string, unknown>): Weighed[] {
  return Object.values(module).filter(
    (value): value is Weighed =>
      typeof value === "object" && value !== null && "extension" in value
  );
}

const VENDORS = Object.entries(MODULES).flatMap(([path, module]) =>
  vendorsIn(module).map((vendor) => ({ path, vendor }))
);

describe("the lock over a vendor's own page", () => {
  /**
   * Issue #138, twice. A page backed by custom resources is useless to a token
   * refused them, so it declares the CRD to ask the authorizer about — and a
   * vendor added after that lock existed declares nothing and is silently
   * never locked, which is how CloudNativePG and Scylla shipped unlocked in
   * 4.12. `defineVendor` types this now; the type is the guard and this is the
   * check that the type has not been loosened back.
   */
  it("is stated by every vendor whose page is backed by custom resources", () => {
    const unstated = VENDORS.filter(
      ({ vendor }) =>
        vendor.crd !== undefined &&
        vendor.page !== undefined &&
        vendor.page.gate === undefined
    ).map(({ path, vendor }) => `${vendor.id} (${path})`);
    expect(unstated).toEqual([]);
  });

  /**
   * A gate is a string the cluster is asked about, so a typo is a question
   * about a CRD that does not exist — answered "no" by an authorizer that has
   * never heard of it, and the row locks for everybody.
   */
  it("names a CRD the way the API server spells one", () => {
    const wrong = VENDORS.flatMap(({ path, vendor }) => {
      const gate = vendor.page?.gate;
      if (!gate) return [];
      const ids = typeof gate.crd === "string" ? [gate.crd] : [...gate.crd];
      return ids
        .filter(
          (id) => !/^[a-z][a-z0-9-]*\.[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(id)
        )
        .map((id) => `${vendor.id} (${path}): ${id}`);
    });
    expect(wrong).toEqual([]);
  });
});
