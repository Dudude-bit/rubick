import { describe, expect, it } from "vitest";

import { listSegment } from "./resource-registry";
import { carriedSearch } from "./carried-search";

/** The real route, so a registry change moves the test with it. */
const PODS = `/c/prod/${listSegment("Pod")}`;

/**
 * Reported on #178: a release's name is part of its pods, its deployments and
 * its configmaps alike, and walking between those lists to follow one name
 * meant typing it again at every stop — the query string was simply dropped
 * by the sidebar link.
 */
describe("the search the sidebar carries", () => {
  it("carries the term from one kind's list to another's", () => {
    expect(carriedSearch("Deployment", { q: "release-42" }, PODS)).toEqual({
      q: "release-42",
    });
  });

  /**
   * Settings and the Overview are not more of the same question, and a
   * search in their address would mean nothing to them.
   */
  it("carries nothing to a row that lists no kind", () => {
    expect(carriedSearch(undefined, { q: "release-42" }, PODS)).toBeUndefined();
  });

  it("leaves the link alone when nothing is being searched for", () => {
    expect(carriedSearch("Pod", {}, PODS)).toBeUndefined();
    expect(carriedSearch("Pod", { view: "tree" }, PODS)).toBeUndefined();
  });

  /** A name with a slash or a space survives the trip as itself. */
  it("hands the term on as itself for the router to escape", () => {
    expect(carriedSearch("Pod", { q: "a b/c" }, PODS)).toEqual({ q: "a b/c" });
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
      carriedSearch(
        "Pod",
        { q: "shop.example.com" },
        "/c/prod/integrations/traefik"
      )
    ).toBeUndefined();
    expect(
      carriedSearch("Pod", { q: "api" }, "/c/prod/pods/web/api-0")
    ).toBeUndefined();
  });
});
