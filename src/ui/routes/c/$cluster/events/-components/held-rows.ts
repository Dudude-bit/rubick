import { useCallback, useMemo, useState } from "react";

/**
 * While `held`, the rows there when the hold began, and how many arrived or
 * changed since. A new `key` is a new question, answered at once; `show`
 * takes the rows as they are now and holds those.
 */
export function useHeldRows<Row>(rows: Row[], held: boolean, key: string) {
  const [snapshot, setSnapshot] = useState<{ rows: Row[]; key: string } | null>(
    null
  );
  if (held && (snapshot === null || snapshot.key !== key))
    setSnapshot({ rows, key });
  if (!held && snapshot !== null) setSnapshot(null);
  const shown = held && snapshot?.key === key ? snapshot.rows : rows;
  const waiting = useMemo(() => {
    if (shown === rows) return 0;
    const drawn = new Set(shown);
    let count = 0;
    for (const row of rows) if (!drawn.has(row)) count++;
    return count;
  }, [shown, rows]);
  const show = useCallback(() => setSnapshot(null), []);
  return { shown, waiting, show };
}

/** `rows` in the order `ids` held them; rows that arrived since come after, in their own order. */
export function inHeldOrder<Row>(
  rows: Row[],
  ids: readonly string[],
  idOf: (row: Row) => string
): Row[] {
  const byId = new Map(rows.map((row) => [idOf(row), row]));
  const held = new Set(ids);
  const kept = ids.flatMap((id) => {
    const row = byId.get(id);
    return row === undefined ? [] : [row];
  });
  return [...kept, ...rows.filter((row) => !held.has(idOf(row)))];
}

/**
 * While `held`, the order the rows had when the hold began, each row still
 * its latest self; a row that arrived meanwhile is added at the end.
 */
export function useHeldOrder<Row>(
  rows: Row[],
  held: boolean,
  key: string,
  idOf: (row: Row) => string
): Row[] {
  const [order, setOrder] = useState<{ ids: string[]; key: string } | null>(
    null
  );
  if (held && (order === null || order.key !== key))
    setOrder({ ids: rows.map(idOf), key });
  if (!held && order !== null) setOrder(null);
  const ids = held && order?.key === key ? order.ids : null;
  return useMemo(
    () => (ids === null ? rows : inHeldOrder(rows, ids, idOf)),
    [rows, ids, idOf]
  );
}
