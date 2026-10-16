import { describe, it, expect } from "vite-plus/test";
import {
  formatTimestamp,
  matchedOutsideMessage,
  matchesQuery,
  parseQueryTerm,
  termLabel,
  type QueryTerm,
  type StreamedLogLine,
} from "./types";

function line(over: Partial<StreamedLogLine> = {}): StreamedLogLine {
  return {
    id: 1,
    epoch: 0,
    groupKey: "",
    timestamp: null,
    message: "dropping batch: queue full",
    level: "error",
    format: "json",
    fields: { component: "ingest", user: "alice" },
    raw: "raw bytes",
    pod: "flood-demo",
    container: "web",
    namespace: "default",
    ...over,
  };
}

describe("parseQueryTerm", () => {
  it("reads a threshold however it is spelled", () => {
    for (const input of ["level>=warn", "level ≥ warn", "level>warn"]) {
      expect(parseQueryTerm(input)).toEqual({
        kind: "level",
        op: "≥",
        value: "warn",
      });
    }
  });

  it("reads an exact level and a negated field", () => {
    expect(parseQueryTerm("level=debug")).toEqual({
      kind: "level",
      op: "=",
      value: "debug",
    });
    // What an unlabelled line reads as, so it can be asked for by name.
    expect(parseQueryTerm("level=unknown")).toEqual({
      kind: "level",
      op: "=",
      value: "unknown",
    });
    expect(parseQueryTerm("component!=ingest")).toEqual({
      kind: "field",
      op: "≠",
      key: "component",
      value: "ingest",
    });
  });

  it("leaves anything it cannot parse as text", () => {
    // `level=nonsense` is not a level, so it stays a field test rather than
    // silently matching nothing under a name it does not own.
    expect(parseQueryTerm("level=nonsense")).toEqual({
      kind: "field",
      op: "=",
      key: "level",
      value: "nonsense",
    });
    expect(parseQueryTerm("queue full")).toEqual({
      kind: "text",
      value: "queue full",
    });
    expect(parseQueryTerm("   ")).toBeNull();
  });

  it("strips the quotes a value may be wrapped in", () => {
    expect(parseQueryTerm('user="alice bob"')).toEqual({
      kind: "field",
      op: "=",
      key: "user",
      value: "alice bob",
    });
  });
});

describe("matchesQuery", () => {
  const term = (input: string) => parseQueryTerm(input) as QueryTerm;

  it("narrows with every term rather than widening", () => {
    const terms = [term("level>=warn"), term("component=ingest")];
    expect(matchesQuery(line(), terms)).toBe(true);
    expect(
      matchesQuery(line({ fields: { component: "api" } }), terms),
      "a line failing one clause is out even though it passes the other"
    ).toBe(false);
  });
});

describe("termLabel", () => {
  it("reads back what was asked, operator included", () => {
    expect(termLabel(parseQueryTerm("level>=warn")!)).toBe("level≥warn");
    expect(termLabel(parseQueryTerm("component=ingest")!)).toBe(
      "component=ingest"
    );
  });
});

describe("formatting", () => {
  it("keeps the clock 24-hour so the column never clips to a meridiem", () => {
    const stamp = new Date(2026, 7, 6, 14, 4, 31).toISOString();
    expect(formatTimestamp(stamp)).toBe("14:04:31");
    expect(formatTimestamp(null)).toBe("--:--:--");
  });
});

describe("where a text query found a line it matched", () => {
  const served = line({
    message: "request served",
    fields: { path: "/api/cart", status: "200" },
    raw: '{"msg":"request served","path":"/api/cart","status":"200"}',
  });

  /** Marco's "cart": the row matched on a field and nothing said so. Fails if the field holding it is not named. */
  it("names the fields that hold it when the message does not", () => {
    expect(matchedOutsideMessage(served, "CART")).toEqual(["path"]);
  });

  /** Fails if a match the message already shows is said a second time. */
  it("says nothing when the message holds it", () => {
    expect(matchedOutsideMessage(served, "served")).toBeNull();
  });

  /** A klog header the parser took off: only Raw draws it. Fails if that reads as a field. */
  it("answers no fields when only the raw line holds it", () => {
    expect(
      matchedOutsideMessage(
        line({
          message: "request served",
          fields: null,
          raw: "I1007 06:41:09.603166 1 server.go:42] request served",
        }),
        "server.go"
      )
    ).toEqual([]);
  });

  /** A row drawn before the filter caught up must not claim a match it does not have. */
  it("says nothing about a line that does not hold it at all", () => {
    expect(matchedOutsideMessage(served, "checkout")).toBeNull();
  });
});
