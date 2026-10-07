import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import type { QuickAction } from "@/components/ui/quick-actions";
import { peekOfRow, type PeekTarget } from "@/hooks/usePeek";
import { useObjectActions } from "../-object/useObjectActions";
import { peekQueryKey, resolveSource } from "../-peek/peek-sources";
import { STALE_TIMES } from "@/lib/refresh";
import { RowMenu, type Listed } from "./RowMenu";

/**
 * The right-click menu of a list row: open it, copy what a terminal needs,
 * and the actions the peek offers, through the same dialogs. One menu and one
 * set of dialogs per list, never per row.
 */
export function useRowMenu<Row extends Listed>({
  kind,
  getRowHref,
  getRowPeek,
}: {
  kind: string | null;
  getRowHref?: (row: Row) => string;
  getRowPeek?: (row: Row) => PeekTarget | null;
}) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const [row, setRow] = useState<Row | null>(null);
  // The object as the peek and the page read it, never the list's row: a row
  // is a summary of another shape (a pod row's containers carry no ports), and
  // until the read lands the actions know as little as the peek's do.
  const target = useMemo(
    () =>
      kind && row
        ? { kind, name: row.name, namespace: row.namespace ?? null }
        : null,
    [kind, row]
  );
  const detail = useQuery({
    queryKey: target ? peekQueryKey(target) : ["row-menu", "none"],
    queryFn: () =>
      resolveSource(target!).fetch(target!.name, target!.namespace),
    enabled: target !== null,
    staleTime: STALE_TIMES.resourceDetail,
    retry: false,
  });
  // Kept after the menu closes: the dialog an item opened still needs it.
  const actions = useObjectActions({
    kind: kind ?? "",
    name: row?.name ?? "",
    namespace: row?.namespace ?? null,
    detail: detail.data,
  });
  const open = useCallback((next: Row, point: { x: number; y: number }) => {
    setRow(next);
    setAt(point);
  }, []);
  // A row's own Delete asks through the menu's, so the button under the
  // pointer asks exactly what the menu does.
  const { askDelete: confirmDelete } = actions;
  const askDelete = useCallback(
    (next: Row) => {
      setRow(next);
      confirmDelete();
    },
    [confirmDelete]
  );

  const element = (quickActions: QuickAction<Row>[]) => (
    <>
      {row && at && (
        <RowMenu
          row={row}
          kind={kind}
          href={getRowHref?.(row)}
          peek={peekOfRow(row, getRowHref, getRowPeek)}
          actions={actions}
          quickActions={quickActions}
          at={at}
          onClose={() => setAt(null)}
        />
      )}
      {actions.dialogs}
    </>
  );
  return { open, askDelete, element };
}
