import { describe, it, expect } from "vitest";
import type { LogLevel } from "@/generated/types";
import { normalizeMessage, groupKeyFor } from "./normalize";

/**
 * These tests are the specification of what "the same line" means.
 * Every `merges` case is a pair a reader would be annoyed to see twice;
 * every `refuses` case is a pair that collapsing would hide a fact
 * behind. The second list is the important one — a grouper that merges
 * too much is worse than no grouper.
 */
const merges = (a: string, b: string) =>
  expect(normalizeMessage(a), `${a}  ==  ${b}`).toBe(normalizeMessage(b));
const refuses = (a: string, b: string) =>
  expect(normalizeMessage(a), `${a}  !=  ${b}`).not.toBe(normalizeMessage(b));

describe("normalizeMessage merges", () => {
  it("counters — the shape of every flooding log", () => {
    merges(
      "flood line 643585 traversing the pipeline",
      "flood line 643586 traversing the pipeline"
    );
    // The counter crossing a digit-width boundary must not split the run.
    merges("flood line 9999999 done", "flood line 10000000 done");
  });

  it("numbers wherever they sit, including decimals", () => {
    merges("queue depth 10000", "queue depth 9");
    merges("cache miss ratio 0.82", "cache miss ratio 1");
    merges("connected to 10.0.0.5:8080", "connected to 10.0.1.240:9090");
  });

  it("uuids", () => {
    merges(
      "request 550e8400-e29b-41d4-a716-446655440000 done",
      "request 6ba7b810-9dad-11d1-80b4-00c04fd430c8 done"
    );
  });

  it("hex ids, prefixed or bare", () => {
    merges("commit a1b2c3d4e5f6 applied", "commit f6e5d4c3b2a1 applied");
    merges("addr 0xdeadbeef mapped", "addr 0x1000 mapped");
  });

  it("durations across the unit the formatter happened to pick", () => {
    // Go's time.Duration prints 900µs, 1.5ms and 2s for the same call
    // site; keeping the unit would split one statement three ways.
    merges("upstream answered in 1.5s", "upstream answered in 900ms");
    merges("took 4.2µs", "took 4200ns");
  });

  it("timestamps embedded in the message", () => {
    merges(
      "checkpoint at 2026-08-06T10:20:47.304650567Z",
      "checkpoint at 2026-08-06T10:21:03.118Z"
    );
    merges("tick 12:04:31.220", "tick 12:05:02.9");
  });

  it("whitespace the formatter padded a column with", () => {
    merges("value    3", "value 4");
  });
});

describe("normalizeMessage refuses", () => {
  it("different words, however alike the rest reads", () => {
    refuses("connecting to payments", "connecting to shipping");
    refuses("error: disk full", "error: disk warm");
    refuses("GET /checkout 200", "POST /checkout 200");
    refuses("GET /checkout 200", "GET /cart 200");
  });

  it("hex-looking words with no digit in them", () => {
    // `deadbeef` and `cafebabe` are both eight a-f characters. Blanking
    // them would merge two unrelated English-ish tokens.
    refuses("marker deadbeef reached", "marker cafebabe reached");
  });

  it("an added or removed clause", () => {
    refuses("dropping batch", "dropping batch: queue full");
  });

  it("a different unit that is not a duration", () => {
    refuses("allocated 512Mi", "allocated 512Gi");
  });

  it("a message that gained a number where the other has none", () => {
    refuses("retrying upstream", "retrying upstream after 3 attempts");
  });

  it("generated names whose digits are interleaved with letters", () => {
    // A known limit, kept on purpose: catching `log-demo-7f9c4` would
    // mean blanking any short digits-and-letters token, and that
    // blanks `sha256`, `utf8`, `x509` and `base64` too.
    refuses("pod log-demo-7f9c4 evicted", "pod log-demo-2b1a8 evicted");
  });
});

interface Sample {
  message: string;
  level: LogLevel | null;
  container: string;
  fields: Record<string, string> | null;
}

describe("groupKeyFor", () => {
  const line = (over: Partial<Sample> = {}): Sample => ({
    message: "flood line 1 traversing",
    level: "info",
    container: "json-logger",
    fields: null,
    ...over,
  });

  it("collapses two occurrences of the same statement", () => {
    expect(groupKeyFor(line())).toBe(
      groupKeyFor(line({ message: "flood line 22 traversing" }))
    );
  });

  it("never crosses a container boundary", () => {
    expect(groupKeyFor(line())).not.toBe(
      groupKeyFor(line({ container: "web" }))
    );
  });

  it("never crosses a level change", () => {
    // The same text logged at warn is the program saying something new.
    expect(groupKeyFor(line())).not.toBe(groupKeyFor(line({ level: "warn" })));
    expect(groupKeyFor(line({ level: null }))).not.toBe(groupKeyFor(line()));
  });

  it("separates a line that gained a field key", () => {
    expect(groupKeyFor(line({ fields: { user: "alice" } }))).not.toBe(
      groupKeyFor(line({ fields: { user: "alice", error: "timeout" } }))
    );
  });

  it("ignores field values, which is the whole point of a count", () => {
    expect(groupKeyFor(line({ fields: { request_id: "req-1" } }))).toBe(
      groupKeyFor(line({ fields: { request_id: "req-2" } }))
    );
  });

  it("ignores the order the fields were parsed in", () => {
    expect(groupKeyFor(line({ fields: { a: "1", b: "2" } }))).toBe(
      groupKeyFor(line({ fields: { b: "2", a: "1" } }))
    );
  });
});
