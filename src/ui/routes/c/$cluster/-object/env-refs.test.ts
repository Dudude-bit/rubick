import { describe, expect, it } from "vite-plus/test";

import type { ConfigData } from "@/generated/types";

import { heldOf, refObjectOf, verdictOf } from "./env-refs";

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

describe("what an object holds under the key an env var names", () => {
  /**
   * A data key is the cluster's to choose: `__proto__` can be one, and
   * `constructor` or `toString` can be asked for without being there.
   * Fails if a key every object has reads as present, with `Object`'s
   * function as its value, or a key that is there under `__proto__` reads
   * as absent.
   */
  it("finds a key only where the object holds it", () => {
    const data = JSON.parse(
      '{"values":{"__proto__":"one","host":"db"},"withheld":{"tls.key":{"says":"privateKey"}},"binary":{}}'
    ) as ConfigData;
    const query = { data, error: null };
    expect(heldOf(query, "__proto__")).toEqual({ is: "value", value: "one" });
    for (const key of ["constructor", "toString", "hasOwnProperty"])
      expect(heldOf(query, key)).toEqual({ is: "absent" });
  });
});
