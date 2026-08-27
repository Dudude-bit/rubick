import { describe, expect, it } from "vitest";

import { describeMatch, fullyRead, readMatch, readMatches } from "./match";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";

/** The English catalogue — what these expectations are written in. */
const t: T = (section, key, values) => translate("en", section, key, values);

describe("what it reads", () => {
  /** The shape most VirtualServices in the world are written in. */
  it("reads a uri prefix", () => {
    const reading = readMatch({ uri: { prefix: "/api" } }, t);
    expect(reading.terms).toEqual(["path starts with /api"]);
    expect(fullyRead(reading)).toBe(true);
    expect(describeMatch(reading, t)).toBe("path starts with /api");
  });

  it("reads an exact path, a method and a port", () => {
    const reading = readMatch(
      {
        uri: { exact: "/healthz" },
        method: { exact: "GET" },
        port: 8080,
      },
      t
    );
    expect(reading.terms).toEqual([
      "path is exactly /healthz",
      "the method is exactly GET",
      "it arrived on port 8080",
    ]);
    expect(fullyRead(reading)).toBe(true);
  });

  it("reads a header by name", () => {
    const reading = readMatch(
      {
        headers: { "x-env": { exact: "staging" }, "x-team": { prefix: "pay" } },
      },
      t
    );
    expect(reading.terms).toEqual([
      "the x-env header is exactly staging",
      "the x-team header starts with pay",
    ]);
    expect(fullyRead(reading)).toBe(true);
  });

  /**
   * Would break if a rule with no conditions started reading as a parse
   * failure. It is the default route — a real configuration, and the one
   * every well-formed VirtualService ends with.
   */
  it("reads a rule with no match block as every request", () => {
    expect(readMatches(undefined, t)).toEqual([]);
    expect(describeMatch(readMatch({}, t), t)).toBe("every request");
  });
});

describe("what it refuses", () => {
  /**
   * The rule the file exists for. There is no sentence about a regular
   * expression shorter than the expression, and "serves /v1 or /v2" from a
   * parser that half-read `^/v[12]/` is the confident wrongness this
   * refuses to produce.
   */
  it("refuses a regular expression and keeps it verbatim", () => {
    const reading = readMatch({ uri: { regex: "^/v[12]/.*$" } }, t);
    expect(reading.terms).toHaveLength(0);
    expect(reading.unread).toEqual(['uri: {"regex":"^/v[12]/.*$"}']);
    expect(fullyRead(reading)).toBe(false);
    expect(reading.raw).toContain("^/v[12]/.*$");
  });

  it("refuses a header matched by regular expression", () => {
    const reading = readMatch(
      { headers: { "x-id": { regex: "^[0-9]+$" } } },
      t
    );
    expect(reading.terms).toHaveLength(0);
    expect(reading.unread[0]).toContain("headers.x-id");
  });

  /**
   * Would break if a condition this app has never heard of were silently
   * dropped. Istio's match language is bigger than this parser and will get
   * bigger; dropping a term makes the route look like it takes traffic it
   * does not.
   */
  it("refuses the conditions it does not know, one line each", () => {
    const reading = readMatch(
      {
        uri: { prefix: "/api" },
        queryParams: { debug: { exact: "1" } },
        sourceLabels: { app: "checkout" },
        withoutHeaders: { "x-skip": { exact: "yes" } },
      },
      t
    );
    expect(reading.terms).toEqual(["path starts with /api"]);
    expect(reading.unread).toHaveLength(3);
    expect(fullyRead(reading)).toBe(false);
    // The prefix it did read is still a fact: conditions in one entry are
    // ANDed, so every request taking this route is under /api.
    expect(describeMatch(reading, t)).toBe(
      "path starts with /api, and more below"
    );
  });

  /**
   * Would break if the flag that changes how every path term is compared
   * were read as just another unknown key — the prefix beside it would then
   * be printed as a requirement that is not the one in force.
   */
  it("refuses the whole entry when ignoreUriCase changes what a path means", () => {
    const reading = readMatch(
      {
        uri: { prefix: "/API" },
        ignoreUriCase: true,
      },
      t
    );
    expect(reading.terms).toHaveLength(0);
    expect(reading.refused).toContain("ignoreUriCase");
    expect(describeMatch(reading, t)).toBe("shown as written below");
  });

  /** Would break if something that is not a match block crashed the page. */
  it("refuses something that is not a match block at all", () => {
    expect(readMatch("uri=/api", t).refused).not.toBeNull();
    expect(readMatch(["/api"], t).refused).not.toBeNull();
    expect(readMatch(null, t).refused).not.toBeNull();
  });
});
