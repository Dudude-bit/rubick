import { useEffect, useMemo } from "react";
import { useQueryClient, type QueryKey } from "@tanstack/react-query";

import type {
  AuditPage,
  AuditQuery,
  ObjectAudit,
  Subject,
  UsageRead,
} from "@/generated/types";
import { useWorkloadUsage } from "@/hooks/useCost";
import { useLiveQuery } from "@/hooks/useLiveQuery";
import { commands } from "@/lib/commands";
import { normalizeTauriError } from "@/lib/error-utils";
import { listenEvent } from "@/lib/events";
import { queryKeys } from "@/lib/query-keys";
import { STALE_TIMES } from "@/lib/refresh";
import { useClusterStore } from "@/stores/clusterStore";
import { basisOf, usageKey, usageRead } from "./usage";

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

  const namespaces = useMemo(
    () => (scope.length > 0 ? [...scope] : null),
    [scope]
  );
  const usage = useAuditUsage(namespaces, true, undefined, true);
  const question = queryKeys.audit(context, scope, query);
  return useLiveQuery({
    queryKey: [...question, usageKey(usage)],
    queryFn: () =>
      read<AuditPage>(() => commands.getAudit(namespaces, query, usage)),
    enabled: connected && !!context,
    staleTime: STALE_TIMES.slow,
    refresh: "steady",
    placeholderData: heldFor(question),
  });
}

/**
 * The answer held while the same question is asked again with a newer
 * reading of usage, and never another object's or another scope's.
 */
function heldFor(question: QueryKey) {
  const asked = JSON.stringify(question);
  return <T>(
    previous: T | undefined,
    previousQuery: { queryKey: QueryKey } | undefined
  ): T | undefined =>
    previousQuery &&
    JSON.stringify(previousQuery.queryKey.slice(0, -1)) === asked
      ? previous
      : undefined;
}

/**
 * What Audit's rule about requests far above use is sent with: the requests
 * list and the usage reading the Cost page reads for the same namespaces
 * (the same queries, so the same answers), judged by the Cost page's own
 * functions. `subject` cuts it to one workload, as its cost line reads it.
 */
function useAuditUsage(
  namespaces: string[] | null,
  heldOnNodes: boolean,
  subject: Subject | null | undefined,
  enabled: boolean
): UsageRead {
  const connected = useClusterStore((s) => s.isConnected);
  const basis = useLiveQuery({
    queryKey: queryKeys.costBasis(namespaces, heldOnNodes),
    queryFn: () => commands.costBasis(namespaces, heldOnNodes),
    enabled: enabled && connected,
    refresh: "steady",
  });
  const kind = subject?.kind;
  const namespace = subject?.namespace;
  const name = subject?.name;
  const asked = useMemo(
    () =>
      kind === undefined
        ? basis.data
        : basisOf(basis.data, {
            kind,
            namespace: namespace ?? null,
            name: name ?? "",
          }),
    [basis.data, kind, namespace, name]
  );
  const keys = useMemo(
    () =>
      asked && asked.workloads.length > 0
        ? asked.workloads.map((w) => w.key)
        : null,
    [asked]
  );
  const usage = useWorkloadUsage(keys ? namespaces : null, keys);
  return useMemo(
    () => usageRead(asked, basis.error, usage),
    [asked, basis.error, usage]
  );
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
  const home = subject?.namespace ?? null;
  const namespaces = useMemo(() => (home ? [home] : null), [home]);
  const judged = useAuditUsage(namespaces, false, subject, enabled && !!home);
  const usage = home ? judged : null;
  const question = queryKeys.auditOf(
    context,
    subject?.kind ?? "",
    subject?.namespace,
    subject?.name ?? "",
    version ?? null
  );
  return useLiveQuery({
    queryKey: [...question, usageKey(usage)],
    queryFn: () =>
      read<ObjectAudit>(() =>
        commands.getAuditOf(
          subject?.kind ?? "",
          subject?.namespace ?? null,
          subject?.name ?? "",
          usage
        )
      ),
    enabled: enabled && connected && !!context && !!subject?.name,
    staleTime: STALE_TIMES.slow,
    refresh: "steady",
    placeholderData: heldFor(question),
  });
}

export type ObjectAuditQuery = ReturnType<typeof useObjectAudit>;
