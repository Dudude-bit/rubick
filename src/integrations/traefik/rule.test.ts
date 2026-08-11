import { describe, expect, it } from "vitest";

import { fullyRead, readRule } from "./rule";

describe("the part of the language it reads", () => {
  /**
   * Would break if the commonest rule of all stopped resolving to one host
   * and one prefix — which is the whole basis of pivoting the page by host.
   */
  it("reads a host and a prefix out of a conjunction", () => {
    const reading = readRule("Host(`shop.example.com`) && PathPrefix(`/api`)");

    expect(fullyRead(reading)).toBe(true);
    expect(reading.clauses).toEqual([
      { host: "shop.example.com", path: { kind: "prefix", value: "/api" } },
    ]);
  });

  /**
   * Would break if `Path` and `PathPrefix` were read as the same thing. They
   * are not: one serves a single URL and the other serves a subtree, and a
   * reader debugging a 404 on `/api/orders` needs to know which was written.
   */
  it("keeps an exact path apart from a prefix", () => {
    expect(readRule("Path(`/healthz`)").clauses[0].path).toEqual({
      kind: "exact",
      value: "/healthz",
    });
  });

  /**
   * Would break if a disjunction stopped becoming one clause per host. `&&`
   * binds tighter than `||` in Traefik, so alternatives need no precedence
   * to split, and a two-host rule is the most common non-trivial rule there
   * is — collapsing it would hide a whole hostname from the page.
   */
  it("reads a top-level disjunction as one route per alternative", () => {
    const reading = readRule(
      "Host(`a.example.com`) || Host(`b.example.com`) && PathPrefix(`/x`)"
    );

    expect(fullyRead(reading)).toBe(true);
    expect(reading.clauses).toEqual([
      { host: "a.example.com", path: null },
      { host: "b.example.com", path: { kind: "prefix", value: "/x" } },
    ]);
  });

  /**
   * Would break if a rule with no host term were dropped instead of filed as
   * a catch-all. A path-only route is deliberate configuration, and it is
   * also the one that quietly swallows every unmatched request.
   */
  it("reads a rule with no host as a catch-all rather than as a failure", () => {
    const reading = readRule("PathPrefix(`/`)");

    expect(fullyRead(reading)).toBe(true);
    expect(reading.clauses).toEqual([
      { host: null, path: { kind: "prefix", value: "/" } },
    ]);
  });
});

describe("what it refuses to paraphrase", () => {
  /**
   * The test this file exists for. Would break the moment a negated rule
   * started being summarised: `!Host(`a`)` matches everything *except* that
   * host, so reading the `Host` term as a requirement states the exact
   * opposite of what the router does.
   */
  it("refuses a negated rule outright and keeps it verbatim", () => {
    const rule = "!Host(`admin.example.com`)";
    const reading = readRule(rule);

    expect(reading.clauses).toEqual([]);
    expect(reading.refused).toBeTruthy();
    expect(reading.raw).toBe(rule);
  });

  /**
   * Would break if grouped expressions started being flattened. Splitting
   * `A && (B || C)` without implementing precedence produces a confidently
   * wrong reading, which is worse than showing the reader the string.
   */
  it("refuses a parenthesised group rather than guess at precedence", () => {
    const reading = readRule(
      "Host(`a.example.com`) && (PathPrefix(`/x`) || PathPrefix(`/y`))"
    );

    expect(reading.clauses).toEqual([]);
    expect(reading.refused).toBeTruthy();
  });

  /**
   * Would break if a matcher outside the three it knows were silently
   * dropped. The host is still a fact — a conjunction only narrows — but a
   * page that said "serves /" while the rule also demanded a header would be
   * telling the reader their working config is broken, or the reverse.
   */
  it("keeps the host of a rule it only partly understands, and says what it left", () => {
    const reading = readRule(
      "Host(`api.example.com`) && Method(`POST`) && ClientIP(`10.0.0.0/8`)"
    );

    expect(reading.clauses).toEqual([{ host: "api.example.com", path: null }]);
    expect(fullyRead(reading)).toBe(false);
    expect(reading.unread).toEqual([
      "Method(`POST`)",
      "ClientIP(`10.0.0.0/8`)",
    ]);
  });

  /**
   * Would break if a rule demanding two hosts at once were filed under one of
   * them. It matches nothing, and naming either host would send somebody to
   * debug a route that cannot fire.
   */
  it("files nothing under a host when the rule requires two at once", () => {
    const reading = readRule("Host(`a.example.com`) && Host(`b.example.com`)");

    expect(reading.clauses).toEqual([]);
    expect(reading.refused).toBeTruthy();
  });

  /**
   * Would break if a regex argument containing a comma or a bracket split the
   * call. `HostRegexp` is not understood either way, but it has to come out
   * as one unread term rather than as parse debris.
   */
  it("walks a quoted argument whole, brackets and commas included", () => {
    const reading = readRule(
      "HostRegexp(`^(a|b)\\.example\\.com$`) && PathPrefix(`/x`)"
    );

    expect(reading.unread).toEqual(["HostRegexp(`^(a|b)\\.example\\.com$`)"]);
    expect(reading.clauses).toEqual([
      { host: null, path: { kind: "prefix", value: "/x" } },
    ]);
  });
});
