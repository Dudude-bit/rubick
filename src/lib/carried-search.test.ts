import { describe, expect, it } from "vitest";

import { withCarriedSearch } from "./carried-search";

/**
 * Reported on #178: a release's name is part of its pods, its deployments and
 * its configmaps alike, and walking between those lists to follow one name
 * meant typing it again at every stop — the query string was simply dropped
 * by the sidebar link.
 */
describe("the search the sidebar carries", () => {
  it("carries the term from one kind's list to another's", () => {
    expect(
      withCarriedSearch("/deployments", "Deployment", "?q=release-42")
    ).toBe("/deployments?q=release-42");
  });

  /**
   * Settings and the Overview are not more of the same question, and a
   * search in their address would mean nothing to them.
   */
  it("carries nothing to a row that lists no kind", () => {
    expect(withCarriedSearch("/settings", undefined, "?q=release-42")).toBe(
      "/settings"
    );
    expect(withCarriedSearch("/", undefined, "?q=release-42")).toBe("/");
  });

  it("leaves the path alone when nothing is being searched for", () => {
    expect(withCarriedSearch("/pods", "Pod", "")).toBe("/pods");
    expect(withCarriedSearch("/pods", "Pod", "?namespace=shop")).toBe("/pods");
  });

  /** A name with a slash or a space survives the trip as itself. */
  it("escapes the term rather than pasting it into the address", () => {
    expect(
      withCarriedSearch("/pods", "Pod", "?q=" + encodeURIComponent("a b/c"))
    ).toBe("/pods?q=a%20b%2Fc");
  });
});
