import { useEffect, useImperativeHandle, useMemo, type Ref } from "react";
import { useQuery } from "@tanstack/react-query";

import { errorToShow } from "@/lib/error-utils";
import { STALE_TIMES } from "@/lib/refresh";
import { useObjectActions } from "../-object/useObjectActions";
import { peekQueryKey, resolveSource } from "../-peek/peek-sources";
import type { PeekActionId } from "../-peek/peek-actions";
import {
  registryKindOf,
  targetKey,
  type ActionsReport,
  type ActionTarget,
} from "./palette-actions";

export interface ActionsRunner {
  run: (id: PeekActionId) => void;
}

/**
 * The object menu's actions for one object, mounted for the palette: the
 * same hook, dialogs and confirmations the peek runs, so a change to any of
 * them reaches the palette too. It reads the object into the entry its page
 * and peek read, and says what it found through `onReport`. Keyed by its
 * target by the caller, so a dialog never outlives the object it was for.
 */
export default function PaletteActionsHost({
  target,
  onReport,
  ref,
}: {
  target: ActionTarget;
  onReport: (report: ActionsReport) => void;
  ref: Ref<ActionsRunner>;
}) {
  const kind = registryKindOf(target);
  const peek = useMemo(
    () => ({
      kind: kind ?? target.kind,
      name: target.name,
      namespace: target.namespace,
    }),
    [kind, target.kind, target.name, target.namespace]
  );
  const source = useMemo(() => resolveSource(peek), [peek]);
  const detail = useQuery({
    queryKey: peekQueryKey(peek),
    queryFn: () => source.fetch(peek.name, peek.namespace),
    staleTime: STALE_TIMES.resourceDetail,
    enabled: kind !== null,
    retry: false,
  });
  const { plan, busy, run, dialogs } = useObjectActions({
    kind: peek.kind,
    name: peek.name,
    namespace: peek.namespace,
    detail: detail.data,
  });
  useImperativeHandle(ref, () => ({ run }), [run]);

  const key = targetKey(target);
  const report: ActionsReport =
    kind !== null && detail.isPending
      ? { target: key, reading: "pending" }
      : kind !== null && detail.error
        ? { target: key, reading: "failed", error: errorToShow(detail.error) }
        : {
            target: key,
            reading: "ready",
            actions: kind ? [...plan.inline, ...plan.menu] : [],
            busy,
          };
  // Every render, and the caller keeps the last report while the words match.
  useEffect(() => onReport(report));

  return dialogs;
}
