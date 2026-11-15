import { useContext, useSyncExternalStore } from "react";
import {
  isCancelledError,
  QueryClientContext,
  type Query,
  type QueryCache,
  type QueryKey,
} from "@tanstack/react-query";

import type { T } from "@/i18n/useT";
import { ERROR_CODES, errorCode, isRefusal } from "@/lib/error-utils";
import { EVERY_NAMESPACE } from "@/lib/query-keys";
import { RESOURCE_REGISTRY, toPlural } from "@/lib/resource-registry";

type Code = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/** Which failures are a read the cluster refused or did not answer, rather than an answer of its own (NotFound) or nothing the cluster was asked. */
const LEFT_UNREAD: Record<Code, boolean> = {
  [ERROR_CODES.UNKNOWN]: true,
  [ERROR_CODES.NETWORK]: true,
  [ERROR_CODES.TIMEOUT]: true,
  [ERROR_CODES.AUTH]: true,
  [ERROR_CODES.CREDENTIALS_EXPIRED]: true,
  [ERROR_CODES.PERMISSION]: true,
  [ERROR_CODES.NOT_FOUND]: false,
  [ERROR_CODES.VALIDATION]: false,
  [ERROR_CODES.KUBE_API]: true,
  [ERROR_CODES.INTERNAL]: true,
  [ERROR_CODES.CONFIG]: false,
  [ERROR_CODES.PLUGIN]: false,
  [ERROR_CODES.TERMINAL]: false,
  [ERROR_CODES.LOG_STREAM]: false,
  [ERROR_CODES.NO_PREVIOUS_RUN]: false,
  [ERROR_CODES.LIST_UNREAD]: true,
  [ERROR_CODES.LOG_NOT_KEPT]: false,
  [ERROR_CODES.READ_DEADLINE]: true,
  [ERROR_CODES.NO_ANSWER]: true,
  [ERROR_CODES.NOT_CONNECTED]: false,
  [ERROR_CODES.LOCAL_PORT_PRIVILEGED]: false,
  [ERROR_CODES.LOCAL_PORT_IN_USE]: false,
  [ERROR_CODES.NO_READY_POD]: false,
  [ERROR_CODES.WITHHELD_VALUE]: false,
};

/**
 * Reads whose failure the strip already draws or that no count rests on:
 * the counts' own overview (unread or failed beside the number), and usage.
 */
const NOT_COUNTED = new Set(["cluster-overview", "metrics"]);

/** A read on screen whose latest answer was a refusal or a failure. */
export interface UnreadRead {
  key: QueryKey;
  refused: boolean;
  error: unknown;
  /** When the latest answer came. */
  at: number;
}

/** Whether `query` is read by something on screen and its latest read was refused or failed. */
export function leftUnread(query: Query): boolean {
  const { status, error } = query.state;
  return (
    status === "error" &&
    !isCancelledError(error) &&
    LEFT_UNREAD[errorCode(error)] &&
    !NOT_COUNTED.has(String(query.queryKey[0])) &&
    query.isActive()
  );
}

interface Store {
  subscribe: (listener: () => void) => () => void;
  get: () => readonly UnreadRead[];
}

const NONE: readonly UnreadRead[] = [];
const stores = new WeakMap<QueryCache, Store>();

/**
 * One cache's unread reads, kept by its own events: each event looks at the
 * one query it is about, so a busy cache costs a status check per change and
 * nothing polls.
 */
function storeOf(cache: QueryCache): Store {
  const known = stores.get(cache);
  if (known) return known;
  const unread = new Map<string, { read: UnreadRead; query: Query }>();
  const listeners = new Set<() => void>();
  let shown = NONE;
  let off: (() => void) | null = null;
  const see = (query: Query): boolean => {
    const hash = query.queryHash;
    const was = unread.get(hash);
    const { error, errorUpdatedAt } = query.state;
    const now =
      cache.get(hash) === query && leftUnread(query)
        ? {
            read: {
              key: query.queryKey,
              refused: isRefusal(error),
              error,
              at: errorUpdatedAt,
            },
            query,
          }
        : undefined;
    if (was?.query === now?.query && was?.read.error === now?.read.error)
      return false;
    if (now) unread.set(hash, now);
    else unread.delete(hash);
    return true;
  };
  const publish = () => {
    shown = [...unread.values()].map(({ read }) => read);
    for (const listener of listeners) listener();
  };
  const store: Store = {
    subscribe: (listener) => {
      listeners.add(listener);
      if (!off) {
        cache.getAll().forEach(see);
        off = cache.subscribe(({ query }) => {
          if (see(query)) publish();
        });
        publish();
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size > 0 || !off) return;
        off();
        off = null;
        unread.clear();
        shown = NONE;
      };
    },
    get: () => shown,
  };
  stores.set(cache, store);
  return store;
}

const nothing = () => () => {};
const none = () => NONE;

/** The reads on screen whose latest answer was a refusal or a failure (not a NotFound, not a cancelled read). */
export function useUnreadOnScreen(): readonly UnreadRead[] {
  const client = useContext(QueryClientContext);
  const store = client ? storeOf(client.getQueryCache()) : null;
  return useSyncExternalStore(store?.subscribe ?? nothing, store?.get ?? none);
}

const SINGULAR = new Map(
  RESOURCE_REGISTRY.map(({ kind }) => [kind.toLowerCase(), kind] as const)
);
const PLURAL = new Map<string, string>([
  ...RESOURCE_REGISTRY.map(
    ({ kind, displayPlural }) => [toPlural(kind), displayPlural] as const
  ),
  ["pod-rows", "Pods"],
]);

/** Reads no screen draws, which the problem count asks to judge what it counts, in words a reader knows. */
const ASKED_FOR_COUNT = {
  "ingress-clients": "readIngressClients",
  "ingress-client-policies": "readIngressClientPolicies",
  "ingress-class": "readIngressClasses",
  "service-health-inputs": "readServiceHealth",
} as const;

/** {@link readName}, but a read the count asks for itself in words rather than by its key. */
export function readWords(key: QueryKey, context: string | null, t: T): string {
  const root = String(key[0]);
  if (!(root in ASKED_FOR_COUNT)) return readName(key, context);
  const what = key.find(
    (part, at) => at > 0 && typeof part === "string" && part !== ""
  );
  return t("cluster", ASKED_FOR_COUNT[root as keyof typeof ASKED_FOR_COUNT], {
    what: typeof what === "string" ? what : "",
  });
}

/**
 * What a read was of, out of its key: the kind and the name of one object,
 * the kind of a list, and otherwise the key's own words, which are the API's
 * names for what it asked and stay as written.
 */
export function readName(key: QueryKey, context: string | null): string {
  const words = key.filter(
    (part): part is string =>
      typeof part === "string" &&
      part !== "" &&
      part !== context &&
      part !== EVERY_NAMESPACE
  );
  const kind = SINGULAR.get(words[0] ?? "");
  if (kind && key.length === 3 && typeof key[2] === "string")
    return `${kind} ${key[2]}`;
  const plural = PLURAL.get(words[0] ?? "");
  if (plural && key.length <= 2) return plural;
  return words.join(" ");
}
