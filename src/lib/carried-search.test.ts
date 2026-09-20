import { describe, expect, it } from "vitest";

import { getResourceListUrl } from "./resource-registry";
import { withCarriedSearch } from "./carried-search";

/** The real route, so a registry change moves the test with it. */
const PODS = getResourceListUrl("Pod");

/**
 * Reported on #178: a release's name is part of its pods, its deployments and
 * its configmaps alike, and walking between those lists to follow one name
 * meant typing it again at every stop — the query string was simply dropped
 * by the sidebar link.
 */
describe("the search the sidebar carries", () => {
  it("carries the term from one kind's list to another's", () => {
    expect(
      withCarriedSearch("/deployments", "Deployment", "?q=release-42", PODS)
    ).toBe("/deployments?q=release-42");
  });

  /**
   * Settings and the Overview are not more of the same question, and a
   * search in their address would mean nothing to them.
   */
  it("carries nothing to a row that lists no kind", () => {
    expect(
      withCarriedSearch("/settings", undefined, "?q=release-42", PODS)
    ).toBe("/settings");
    expect(withCarriedSearch("/", undefined, "?q=release-42", PODS)).toBe("/");
  });

  it("leaves the path alone when nothing is being searched for", () => {
    expect(withCarriedSearch(PODS, "Pod", "", PODS)).toBe(PODS);
    expect(withCarriedSearch(PODS, "Pod", "?namespace=shop", PODS)).toBe(PODS);
  });

  /** A name with a slash or a space survives the trip as itself. */
  it("escapes the term rather than pasting it into the address", () => {
    expect(
      withCarriedSearch(PODS, "Pod", "?q=" + encodeURIComponent("a b/c"), PODS)
    ).toBe(`${PODS}?q=a%20b%2Fc`);
  });

  /**
   * `q` is not reserved. The Traefik page reads it as a hostname filter its
   * own map sets by a click, so carrying from there pointed every kind row
   * at `/pods?q=shop.example.com` — an empty list filtered by something the
   * reader never typed into it. Gated on both ends, not just the
   * destination.
   */
  it("carries nothing from a page where q is not the list search", () => {
    expect(
      withCarriedSearch(
        PODS,
        "Pod",
        "?q=shop.example.com",
        "/integrations/traefik"
      )
    ).toBe(PODS);
  });
});
