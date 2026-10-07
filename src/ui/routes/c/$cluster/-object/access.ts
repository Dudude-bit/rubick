import { useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { commands } from "@/lib/commands";
import { isRefusal } from "@/lib/error-utils";
import { queryKeys } from "@/lib/query-keys";
import {
  currentConnection,
  noteRefusal,
  readOf,
  useRefusedAmong,
} from "@/lib/refusals";
import { listQueryFor, toKind } from "@/lib/resource-registry";
import { useClusterStore } from "@/stores/clusterStore";
import type { ListQuery } from "@/generated/types";
import type { T } from "@/i18n/useT";
import { useT } from "@/i18n/useT";

/** The verbs a destructive action needs: delete takes an object away, patch is scale and restart. */
export type GuardedVerb = "delete" | "patch";

const GUARDED: readonly GuardedVerb[] = ["delete", "patch"];

/** What an action is about, in the terms the API server's authorizer matches. */
export interface Guarded {
  group: string;
  resource: string;
  namespace: string | null;
}

export function guardedOf(
  kind: string,
  namespace: string | null
): Guarded | null {
  const known = toKind(kind);
  if (!known) return null;
  const { group, resource, namespaced } = listQueryFor(known);
  if (namespaced && !namespace) return null;
  return { group, resource, namespace: namespaced ? namespace : null };
}

/** The refusal memory's key for one verb on one resource. */
export function deniedRead(verb: GuardedVerb, on: Guarded): string {
  return readOf("may", [verb, on.group, on.resource, on.namespace])!;
}

/** A refusal learned by trying, kept beside the access review's own. */
export function noteDenied(
  verb: GuardedVerb,
  on: Guarded | null,
  error: unknown
): void {
  if (on && isRefusal(error))
    noteRefusal(deniedRead(verb, on), error, currentConnection());
}

/**
 * Asks the cluster's access review, once per connection, whether this user
 * may delete and patch each of `on`. A "no" goes to the refusal memory; a
 * review that would not answer, or could not be asked, notes nothing, so
 * the action stays offered with no claim about it.
 */
export function useAccessReview(on: readonly Guarded[]): void {
  const connection = useClusterStore((s) => s.connectionAttemptId);
  const context = useClusterStore((s) => s.currentContext);
  const connected = useClusterStore((s) => s.isConnected);
  const queries = on.flatMap((target) =>
    GUARDED.map((verb) => ({ ...target, verb }))
  );
  const asked = queries.map((query) => deniedRead(query.verb, query)).sort();
  useQuery({
    queryKey: queryKeys.accessReview(context, connection, asked),
    enabled: connected && !!context && queries.length > 0,
    staleTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const answers = await commands.checkAccess(queries);
      answers.forEach((answer, at) => {
        if (answer.allowed !== false) return;
        const query = queries[at];
        noteRefusal(
          deniedRead(query.verb, query),
          `SelfSubjectAccessReview: may not ${query.verb} ${query.resource}`,
          connection
        );
      });
      return answers.map((answer) => answer.allowed);
    },
  });
}

/** Why `verb` on `on` is not this user's to run, as `kubectl auth can-i` would ask it. */
export function deniedWords(t: T, verb: GuardedVerb, on: Guarded): string {
  const resource = on.group ? `${on.resource}.${on.group}` : on.resource;
  return t("action", "notPermitted", {
    check: [verb, resource, ...(on.namespace ? ["-n", on.namespace] : [])].join(
      " "
    ),
  });
}

/** The guarded verbs this user may not run on `on`, each with its reason. */
export function useDenied(
  on: Guarded | null
): Partial<Record<GuardedVerb, string>> {
  const t = useT();
  const connection = useClusterStore((s) => s.connectionAttemptId);
  useAccessReview(on ? [on] : []);
  const refused = useRefusedAmong(
    connection,
    on ? GUARDED.map((verb) => deniedRead(verb, on)) : []
  );
  if (!on) return {};
  return Object.fromEntries(
    GUARDED.filter((verb) => refused.has(deniedRead(verb, on))).map((verb) => [
      verb,
      deniedWords(t, verb, on),
    ])
  );
}

/** Why the cluster will not take an edited manifest of this object from this user. */
export function useEditDenied(
  key: { kind: string; namespace?: string | null } | null
): string | undefined {
  return useDenied(key && guardedOf(key.kind, key.namespace ?? null)).patch;
}

/**
 * Why a list row may not be deleted, for the namespaces the reader chose:
 * those are asked. A row elsewhere, or a review that would not answer, gets
 * no reason, and its Delete stays offered with no claim.
 */
export function useRowDeleteDenial(
  list: ListQuery | null,
  namespaces: readonly string[]
): (row: { namespace?: string | null }) => string | undefined {
  const t = useT();
  const connection = useClusterStore((s) => s.connectionAttemptId);
  const group = list?.group;
  const resource = list?.resource;
  const namespaced = list?.namespaced;
  const asked = useMemo<Guarded[]>(() => {
    if (group === undefined || resource === undefined) return [];
    return namespaced
      ? namespaces.map((namespace) => ({ group, resource, namespace }))
      : [{ group, resource, namespace: null }];
  }, [group, resource, namespaced, namespaces]);
  useAccessReview(asked);
  const refused = useRefusedAmong(
    connection,
    asked.map((on) => deniedRead("delete", on))
  );
  return useCallback(
    (row) => {
      if (group === undefined || resource === undefined) return undefined;
      const on = {
        group,
        resource,
        namespace: namespaced ? (row.namespace ?? null) : null,
      };
      return refused.has(deniedRead("delete", on))
        ? deniedWords(t, "delete", on)
        : undefined;
    },
    [group, resource, namespaced, refused, t]
  );
}
