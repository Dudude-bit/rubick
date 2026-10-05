import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import type { QuickAction } from "@/components/ui/quick-actions";
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
  quickActions,
}: {
  kind: string | null;
  getRowHref?: (row: Row) => string;
  quickActions?: QuickAction<Row>[];
}) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const [row, setRow] = useState<Row | null>(null);
  // The object as the peek and the page read it, not the list's row: a
  // StatefulSet row has no claim templates, and its delete dialog said they
  // were not read yet, for ever.
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
    detail: detail.data ?? row ?? undefined,
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
