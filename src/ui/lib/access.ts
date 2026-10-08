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
  useRightsAsked,
} from "@/lib/refusals";
import { seedScope } from "@/lib/namespace-scope";
import { listQueryFor, toKind } from "@/lib/resource-registry";
import { useClusterStore } from "@/stores/clusterStore";
import type { ListQuery } from "@/generated/types";
import type { T } from "@/i18n/useT";
import { useT } from "@/i18n/useT";

/**
 * The verbs an action needs: delete takes an object away, patch is every
 * edit, scale and restart, create is a shell, a forward or a debug pod.
 */
export type GuardedVerb = "delete" | "patch" | "create";

const GUARDED = ["delete", "patch"] as const;

/** What an action is about, in the terms the API server's authorizer matches. */
export interface Guarded {
  group: string;
  resource: string;
  namespace: string | null;
  /** The part of the object the verb reaches: `exec` in `pods/exec`. */
  subresource?: string;
}

/** One question for the authorizer: may this user `verb` this. */
export interface Asked extends Guarded {
  verb: GuardedVerb;
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
  return readOf("may", [
    verb,
    on.group,
    on.resource,
    on.namespace,
    ...(on.subresource ? [on.subresource] : []),
  ])!;
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
 * Asks the cluster's access review, once per connection, each of `asked`.
 * A "no" goes to the refusal memory; a review that would not answer, or
 * could not be asked, notes nothing, so the action stays offered with no
 * claim about it.
 */
export function useAccessReview(asked: readonly Asked[]): void {
  const connection = useClusterStore((s) => s.connectionAttemptId);
  const context = useClusterStore((s) => s.currentContext);
  const connected = useClusterStore((s) => s.isConnected);
  const rights = useRightsAsked();
  const reads = asked.map((query) => deniedRead(query.verb, query)).sort();
  useQuery({
    queryKey: queryKeys.accessReview(context, connection, rights, reads),
    enabled: connected && !!context && asked.length > 0,
    staleTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const answers = await commands.checkAccess(
        asked.map(({ verb, group, resource, namespace, subresource }) => ({
          verb,
          group,
          resource,
          namespace,
          subresource,
        }))
      );
      answers.forEach((answer, at) => {
        if (answer.allowed !== false) return;
        const query = asked[at];
        noteRefusal(
          deniedRead(query.verb, query),
          `SelfSubjectAccessReview: may not ${query.verb} ${checkOf(query)}`,
          connection
        );
      });
      return answers.map((answer) => answer.allowed);
    },
  });
}

/** `create pods/exec -n shop`: the question as `kubectl auth can-i` takes it. */
function checkOf(asked: Asked): string {
  const resource =
    (asked.group ? `${asked.resource}.${asked.group}` : asked.resource) +
    (asked.subresource ? `/${asked.subresource}` : "");
  return [
    asked.verb,
    resource,
    ...(asked.namespace ? ["-n", asked.namespace] : []),
  ].join(" ");
}

/** Why `verb` on `on` is not this user's to run, as `kubectl auth can-i` would ask it. */
export function deniedWords(t: T, verb: GuardedVerb, on: Guarded): string {
  return t("action", "notPermitted", { check: checkOf({ ...on, verb }) });
}

/**
 * Why each of `asked` is not this user's to run, in the same order: a
 * reason where the review said no, nothing where it said yes or could not
 * say. `null` asks nothing.
 */
export function useDeniedOf(
  asked: readonly (Asked | null)[]
): (string | undefined)[] {
  const t = useT();
  const connection = useClusterStore((s) => s.connectionAttemptId);
  const real = asked.filter((query): query is Asked => query !== null);
  useAccessReview(real);
  const refused = useRefusedAmong(
    connection,
    real.map((query) => deniedRead(query.verb, query))
  );
  return asked.map((query) =>
    query && refused.has(deniedRead(query.verb, query))
      ? deniedWords(t, query.verb, query)
      : undefined
  );
}

/** Whether this user may delete and patch `on`, each refusal with its reason. */
export function useDenied(
  on: Guarded | null
): Partial<Record<(typeof GUARDED)[number], string>> {
  const [remove, patch] = useDeniedOf(
    GUARDED.map((verb) => (on ? { ...on, verb } : null))
  );
  return { delete: remove, patch };
}

/**
 * What a pod's own actions ask, as one review every surface that draws them
 * shares: the peek, the row menu, the palette, the page and the dialogs.
 */
function podAsks(namespace: string | null): Asked[] | null {
  if (!namespace) return null;
  const pods = { group: "", resource: "pods", namespace };
  return [
    { ...pods, verb: "patch", subresource: "ephemeralcontainers" },
    { ...pods, verb: "create" },
    { ...pods, verb: "create", subresource: "exec" },
    { ...pods, verb: "create", subresource: "portforward" },
  ];
}

export interface PodDenied {
  /** An ephemeral debug container, `kubectl debug` without `--copy-to`. */
  ephemeral?: string;
  /** A debug copy of the pod, which is a new pod. */
  copy?: string;
  /** Debug at all: only when neither way is open. */
  debug?: string;
  shell?: string;
  portForward?: string;
}

/** Why each of a pod's own actions is not this user's to run in `namespace`. */
export function usePodDenied(namespace: string | null): PodDenied {
  const t = useT();
  const asks = podAsks(namespace);
  const [ephemeral, copy, shell, portForward] = useDeniedOf(
    asks ?? [null, null, null, null]
  );
  const debug =
    asks && ephemeral && copy
      ? t("action", "notPermittedEither", {
          check: checkOf(asks[0]),
          other: checkOf(asks[1]),
        })
      : undefined;
  return { ephemeral, copy, debug, shell, portForward };
}

/**
 * The namespace a node's debug pod goes into unless the reader types another:
 * the one in view, else the kubeconfig context's, else `default`, as
 * `kubectl debug node` picks.
 */
export function useNodeDebugNamespace(): string {
  const scope = useClusterStore((s) => s.namespaceScope);
  const configured = useClusterStore(
    (s) => s.contexts.find((c) => c.name === s.currentContext)?.namespace
  );
  return scope[0] ?? seedScope(configured)[0] ?? "default";
}

/**
 * Why a node's debug pod is not this user's to start in `namespace`: it is a
 * new pod there, and the app's way into it afterwards is an exec.
 */
export function useNodeDebugDenied(
  namespace: string | null
): string | undefined {
  const pods = namespace ? { group: "", resource: "pods", namespace } : null;
  const [create, exec] = useDeniedOf(
    pods
      ? [
          { ...pods, verb: "create" },
          { ...pods, verb: "create", subresource: "exec" },
        ]
      : [null, null]
  );
  return create ?? exec;
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
  // Delete and patch, as the peek asks them, so the two share one review.
  const review = useMemo(
    () => asked.flatMap((on) => GUARDED.map((verb) => ({ ...on, verb }))),
    [asked]
  );
  useAccessReview(review);
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
