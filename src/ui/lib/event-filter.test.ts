import { describe, expect, it } from "vitest";

import { eventMatches, filterEvents } from "./event-filter";
import type { EventInfo } from "@/generated/types";

const event = (over: Partial<EventInfo> = {}): EventInfo =>
  ({
    name: "e1",
    namespace: "prod",
    uid: "u1",
    type: "Normal",
    reason: "Scheduled",
    message: "Successfully assigned prod/web-7f9 to node-1",
    source: null,
    involvedObject: {
      kind: "Pod",
      name: "web-7f9",
      namespace: "prod",
      uid: "o-web-7f9",
    },
    count: 1,
    firstTimestamp: null,
    lastTimestamp: null,
    ...over,
  }) as EventInfo;

describe("finding events in a feed", () => {
  it("matches the object's name, which is what the reader is after", () => {
    expect(eventMatches(event(), "web-")).toBe(true);
    expect(eventMatches(event(), "api-")).toBe(false);
  });

  it("matches the reason, the kind, the namespace and the message", () => {
    expect(eventMatches(event(), "scheduled")).toBe(true);
    expect(eventMatches(event(), "pod")).toBe(true);
    expect(eventMatches(event(), "prod")).toBe(true);
    expect(eventMatches(event(), "node-1")).toBe(true);
  });

  it("ignores case, the way the lists' search box does", () => {
    expect(eventMatches(event(), "WEB-7F9")).toBe(true);
  });

  /** A filter nobody has typed into is not a filter that hides things. */
  it("keeps everything when nothing was typed", () => {
    expect(eventMatches(event(), "")).toBe(true);
    expect(eventMatches(event(), "   ")).toBe(true);
    const feed = [event(), event({ uid: "u2" })];
    expect(filterEvents(feed, "")).toBe(feed);
  });

  /**
   * The letters typed, not a pattern. The day a pod is called `api.v2`, a
   * regex would quietly stop meaning what the reader wrote.
   */
  it("takes the query literally", () => {
    const dotted = event({
      involvedObject: {
        kind: "Pod",
        name: "api.v2",
        namespace: "prod",
        uid: "o-api.v2",
      },
      message: null,
      reason: null,
    });
    expect(eventMatches(dotted, "api.v2")).toBe(true);
    expect(eventMatches(dotted, "api?v2")).toBe(false);
    expect(eventMatches(dotted, "apixv2")).toBe(false);
  });

  /** Absent fields are absent, not the string "null". */
  it("does not match the word null on an empty field", () => {
    const bare = event({ reason: null, message: null });
    expect(eventMatches(bare, "null")).toBe(false);
  });

  it("narrows a feed to the rows that match", () => {
    const about = (uid: string, name: string) =>
      event({
        uid,
        message: `something happened to ${name}`,
        involvedObject: {
          kind: "Pod",
          name,
          namespace: "prod",
          uid: `o-${uid}`,
        },
      });
    const feed = [
      about("a", "web-1"),
      about("b", "api-1"),
      about("c", "web-2"),
    ];
    expect(filterEvents(feed, "web").map((e) => e.uid)).toEqual(["a", "c"]);
  });

  /**
   * The message is part of the row, so it is part of the search. An event
   * about `api-1` that mentions `web-7f9` is a row with those letters on it,
   * and hiding it would be the filter lying about what is on screen.
   */
  it("matches a message even when the object does not", () => {
    const referring = event({
      involvedObject: {
        kind: "Pod",
        name: "api-1",
        namespace: "prod",
        uid: "o9",
      },
      message: "failed to reach web-7f9",
    });
    expect(eventMatches(referring, "web-7f9")).toBe(true);
  });
});
