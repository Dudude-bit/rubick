import { useCallback, useState } from "react";

import type { QuickAction } from "@/components/ui/quick-actions";
import { useObjectActions } from "../-object/useObjectActions";
import { RowMenu, type Listed } from "./RowMenu";

/**
 * The right-click menu of a list row: open it, copy what a terminal needs,
 * and the actions the peek offers, through the same dialogs. One menu and one
 * set of dialogs per list, never per row.
 */
export function useRowMenu<Row extends Listed>({
  kind,
  getRowHref,
  quickActions,
}: {
  kind: string | null;
  getRowHref?: (row: Row) => string;
  quickActions?: QuickAction<Row>[];
}) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const [row, setRow] = useState<Row | null>(null);
  // Kept after the menu closes: the dialog an item opened still needs it.
  const actions = useObjectActions({
    kind: kind ?? "",
    name: row?.name ?? "",
    namespace: row?.namespace ?? null,
    detail: row ?? undefined,
  });
  const open = useCallback((next: Row, point: { x: number; y: number }) => {
    setRow(next);
    setAt(point);
  }, []);

  const element = (
    <>
      {row && at && (
        <RowMenu
          row={row}
          kind={kind}
          href={getRowHref?.(row)}
          actions={actions}
          quickActions={quickActions ?? []}
          at={at}
          onClose={() => setAt(null)}
        />
      )}
      {actions.dialogs}
    </>
  );
  return { open, element };
}
