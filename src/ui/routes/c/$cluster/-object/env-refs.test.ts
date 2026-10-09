import { describe, expect, it } from "vite-plus/test";

import { refObjectOf, verdictOf } from "./env-refs";

describe("a reference settled against its object", () => {
  /** A 404 is the object gone; a 403 is not knowing. Collapsing them draws a
   *  refused Secret as missing, or a missing one as merely unreadable. */
  it("tells a missing object from a refused one", () => {
    expect(
      refObjectOf({ error: { code: "NOT_FOUND", message: "not found" } })
    ).toEqual({ state: "missing" });
    expect(
      refObjectOf({ error: { code: "PERMISSION_DENIED", message: "no" } })
    ).toEqual({ state: "refused" });
    expect(
      refObjectOf({ error: { code: "NETWORK_ERROR", message: "reset" } }).state
    ).toBe("unread");
    expect(refObjectOf({ error: null })).toEqual({ state: "reading" });
  });

  /** The key is checked against the keys the object holds, and they come back
   *  with the verdict so the reader sees the near miss. */
  it("names the keys an object holds when the one asked for is not among them", () => {
    const object = refObjectOf({
      data: { dataKeys: ["password", "username"] },
      error: null,
    });
    expect(verdictOf(object, "DB_PASSWORD")).toEqual({
      verdict: "keyMissing",
      keys: ["password", "username"],
    });
    expect(verdictOf(object, "password")).toEqual({ verdict: "present" });
    expect(verdictOf(object, null)).toEqual({ verdict: "present" });
  });

  /** An object nobody could read says nothing about its keys. */
  it("never calls a key missing in an object it could not read", () => {
    expect(verdictOf({ state: "refused" }, "DB_PASSWORD")).toEqual({
      verdict: "refused",
    });
    expect(verdictOf(undefined, "DB_PASSWORD")).toEqual({
      verdict: "reading",
    });
  });
});
