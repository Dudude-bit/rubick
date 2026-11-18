import { describe, expect, it } from "vite-plus/test";

import {
  entriesOf,
  entryOf,
  named,
  storedEntries,
  withEntry,
  withoutEntry,
} from "./named";

describe("a record keyed by names a cluster chose", () => {
  /**
   * `__proto__` and `constructor` are entries like any other. Fails if a
   * write by that name sets the prototype, or a read of a name nobody wrote
   * finds an inherited property.
   */
  it("keeps __proto__ and constructor as its own entries", () => {
    const empty = named<number>();
    expect(entryOf(empty, "constructor")).toBeUndefined();
    expect(entryOf(empty, "__proto__")).toBeUndefined();
    expect(entryOf(empty, "toString")).toBeUndefined();

    const written = withEntry(
      withEntry(withEntry(empty, "prod", 1), "__proto__", 2),
      "constructor",
      3
    );
    expect(entryOf(written, "__proto__")).toBe(2);
    expect(entryOf(written, "constructor")).toBe(3);
    expect(Object.getPrototypeOf(written)).toBe(Object.prototype);
    expect(entriesOf(written)).toEqual([
      ["prod", 1],
      ["__proto__", 2],
      ["constructor", 3],
    ]);
    expect(entriesOf(withoutEntry(written, "__proto__"))).toEqual([
      ["prod", 1],
      ["constructor", 3],
    ]);
  });

  /**
   * What is persisted is a plain object, read back by JSON.parse. Fails if
   * a stored `__proto__` is lost on the way back, or the shape changes.
   */
  it("is stored as a plain object and read back whole", () => {
    const written = withEntry(
      withEntry(named<number>(), "__proto__", 2),
      "a",
      1
    );
    const stored = JSON.stringify(written);
    expect(stored).toBe('{"__proto__":2,"a":1}');
    const read = named<number>(JSON.parse(stored) as Record<string, number>);
    expect(entryOf(read, "__proto__")).toBe(2);
    expect(entriesOf(read)).toEqual([
      ["__proto__", 2],
      ["a", 1],
    ]);
  });

  /** A restore reads whatever was on the disk. Fails if a stored `__proto__` is dropped, or a value that is no record yields entries. */
  it("reads back only the own entries of a stored record", () => {
    expect(storedEntries(JSON.parse('{"__proto__":1,"a":2}'))).toEqual([
      ["__proto__", 1],
      ["a", 2],
    ]);
    for (const nothing of [null, undefined, "x", 3, ["a"]])
      expect(storedEntries(nothing)).toEqual([]);
  });

  /**
   * A record is told from entries by whether it can be iterated, not by
   * whether a property of that name is there. Fails if a record carrying a
   * non-callable `Symbol.iterator` throws instead of giving its entries.
   */
  it("takes a record with a stray Symbol.iterator as a record", () => {
    const odd = { prod: 1, [Symbol.iterator]: 0 } as unknown as Record<
      string,
      number
    >;
    expect(entriesOf(named(odd))).toEqual([["prod", 1]]);
    expect(entriesOf(named(new Map([["prod", 2]])))).toEqual([["prod", 2]]);
  });
});
