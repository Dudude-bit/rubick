import { describe, it, expect } from "vitest";
import {
  formatCount,
  formatTimestamp,
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

  it("orders levels so a threshold means something", () => {
    expect(matchesQuery(line({ level: "error" }), [term("level>=warn")])).toBe(
      true
    );
    expect(matchesQuery(line({ level: "info" }), [term("level>=warn")])).toBe(
      false
    );
  });

  it("keeps unparsed levels out of a threshold query", () => {
    // A line the parser could not read a level out of is not evidence of
    // trouble, and returning every one of them would bury the ones that are.
    expect(matchesQuery(line({ level: null }), [term("level>=warn")])).toBe(
      false
    );
    expect(matchesQuery(line({ level: null }), [term("level=unknown")])).toBe(
      true
    );
  });

  it("matches the container by name even though it is not a parsed field", () => {
    expect(matchesQuery(line(), [term("container=web")])).toBe(true);
    expect(matchesQuery(line(), [term("container=sidecar")])).toBe(false);
  });

  it("narrows with every term rather than widening", () => {
    const terms = [term("level>=warn"), term("component=ingest")];
    expect(matchesQuery(line(), terms)).toBe(true);
    expect(
      matchesQuery(line({ fields: { component: "api" } }), terms),
      "a line failing one clause is out even though it passes the other"
    ).toBe(false);
  });

  it("searches the raw bytes as well as the message", () => {
    expect(matchesQuery(line(), [term("raw bytes")])).toBe(true);
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

  it("groups long counts without punctuating the sentence around them", () => {
    expect(formatCount(2481)).toBe("2\u202f481");
    expect(formatCount(12)).toBe("12");
    expect(formatCount(1234567)).toBe("1\u202f234\u202f567");
  });
});
