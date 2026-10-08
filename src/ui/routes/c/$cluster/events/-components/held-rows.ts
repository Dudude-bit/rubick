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
