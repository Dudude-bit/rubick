import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";

import { useHeldRows } from "./held-rows";

type Row = { id: string; v: number };
const row = (id: string, v = 0): Row => ({ id, v });
const idOf = (r: Row) => r.id;

describe("useHeldRows", () => {
  /**
   * The Events table kept 279 rows under the pointer while the header and the
   * sidebar counted the 270 the cluster still had, and nothing said so because
   * only arrivals were counted. Fails if rows that went away while held are
   * not counted as updates, or if a changed row counts twice.
   */
  it("counts rows that went away, arrived and changed since the hold began, each once", () => {
    const first = [row("a"), row("b"), row("c")];
    const { result, rerender } = renderHook(
      ({ rows, held }) => useHeldRows(rows, held, "q", idOf),
      { initialProps: { rows: first, held: true } }
    );
    expect(result.current.waiting).toBe(0);
    rerender({ rows: [first[0], row("b", 1), row("d")], held: true });
    expect(result.current.shown).toBe(first);
    expect(result.current.waiting).toBe(3);
  });

  /** Fails if a hold with nothing changed reports waiting updates. */
  it("reports nothing while nothing changed", () => {
    const first = [row("a")];
    const { result, rerender } = renderHook(
      ({ rows }) => useHeldRows(rows, true, "q", idOf),
      { initialProps: { rows: first } }
    );
    rerender({ rows: first });
    expect(result.current.waiting).toBe(0);
  });

  /** Fails if, with no id to tell a changed row from a new one, a removal is not counted at all. */
  it("counts removals without ids as at least the rows that went", () => {
    const first = [row("a"), row("b")];
    const { result, rerender } = renderHook(
      ({ rows }) => useHeldRows(rows, true, "q"),
      { initialProps: { rows: first } }
    );
    rerender({ rows: [first[0]] });
    expect(result.current.waiting).toBe(1);
  });
});
