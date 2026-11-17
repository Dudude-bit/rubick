import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";

import type {
  AuditPage,
  AuditQuery,
  ObjectAudit,
  Subject,
} from "@/generated/types";
import { useLiveQuery } from "@/hooks/useLiveQuery";
import { commands } from "@/lib/commands";
import { normalizeTauriError } from "@/lib/error-utils";
import { listenEvent } from "@/lib/events";
import { queryKeys } from "@/lib/query-keys";
import { STALE_TIMES } from "@/lib/refresh";
import { useClusterStore } from "@/stores/clusterStore";

async function read<T>(ask: () => Promise<T>): Promise<T> {
  try {
    return await ask();
  } catch (err) {
    throw new Error(normalizeTauriError(err), { cause: err });
  }
}

/**
 * One page of the Audit page's answer for the window's namespaces. Asking
 * is what keeps Audit's watches running; they stop three minutes after the
 * page is left. Read again when the backend says its watches moved, at most
 * once a second, and otherwise at the rate of things that change with a deploy.
 */
export function useAuditPage(query: AuditQuery) {
  const context = useClusterStore((s) => s.currentContext);
  const connected = useClusterStore((s) => s.isConnected);
  const scope = useClusterStore((s) => s.namespaceScope);
  const client = useQueryClient();

  useEffect(() => {
    if (!context) return;
    let left = false;
    let leave: (() => void) | undefined;
    void listenEvent("audit-changed", ({ payload }) => {
      if (payload.context !== context) return;
      void client.invalidateQueries({
        queryKey: queryKeys.everyAudit(context),
      });
    }).then((unlisten) => {
      if (left) unlisten();
      else leave = unlisten;
    });
    return () => {
      left = true;
      leave?.();
    };
  }, [context, client]);

  return useLiveQuery({
    queryKey: queryKeys.audit(context, scope, query),
    queryFn: () =>
      read<AuditPage>(() =>
        commands.getAudit(scope.length > 0 ? [...scope] : null, query)
      ),
    enabled: connected && !!context,
    staleTime: STALE_TIMES.slow,
    refresh: "steady",
  });
}

/**
 * One workload's or pod's findings: the tab's count and the tab's body
 * read this one answer, so the two cannot disagree. It never starts the
 * Audit page's watches; `version` is the object's resourceVersion, so an
 * edit to it is judged at once.
 */
export function useObjectAudit(
  subject: Subject | null,
  version?: string | null,
  enabled = true
) {
  const context = useClusterStore((s) => s.currentContext);
  const connected = useClusterStore((s) => s.isConnected);
  return useLiveQuery({
    queryKey: queryKeys.auditOf(
      context,
      subject?.kind ?? "",
      subject?.namespace,
      subject?.name ?? "",
      version ?? null
    ),
    queryFn: () =>
      read<ObjectAudit>(() =>
        commands.getAuditOf(
          subject?.kind ?? "",
          subject?.namespace ?? null,
          subject?.name ?? ""
        )
      ),
    enabled: enabled && connected && !!context && !!subject?.name,
    staleTime: STALE_TIMES.slow,
    refresh: "steady",
  });
}

export type ObjectAuditQuery = ReturnType<typeof useObjectAudit>;
