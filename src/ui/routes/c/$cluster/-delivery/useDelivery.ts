/**
 * Who delivered these objects — asked of every delivery controller the cluster
 * has, and of nothing at all when it has none.
 *
 * ## What this costs on a five-hundred-row list
 *
 * One call per installed controller, per page. Not per row: the claim is a
 * label the list already fetched, so "is this delivered" is free and works in a
 * table; only *confirming* the claim needs the owner, and the owners are read
 * once and shared across every row. A page of five hundred Deployments on a
 * cluster running both Argo and Flux costs three list calls — one for
 * Applications, one for Kustomizations, one for HelmReleases — and the rest is
 * map lookups. A page where nothing carries a delivery label costs **zero**
 * calls, because each vendor checks the labels before it reads anything.
 *
 * ## Why it asks everybody
 *
 * `useCapability` answers with the first provider, which is right for a
 * question with one answer. Delivery is not one: Argo and Flux are routinely
 * installed side by side, and an object claimed by both is a real and bad state
 * — two controllers each undoing the other — that a first-hit lookup could
 * never see.
 */

import { useT } from "@/i18n/useT";
import { useMemo } from "react";
import { useQueries } from "@tanstack/react-query";

import {
  deliveryKey,
  useCapabilities,
  type Delivery,
  type DeliveryQuery,
} from "@/integrations";
import { deliveryIntercept, type DeliveryIntercept } from "@/lib/delivery";

const STALE = 30_000;

export interface Deliveries {
  /**
   * Whether anything in this cluster can answer at all.
   *
   * `false` is the state most readers are in and is not an error: every
   * surface draws exactly what it drew before delivery existed — no column, no
   * mark, and no gap where one would go.
   */
  available: boolean;
  /** Every answer about one object, and an empty list where nothing claims it. */
  of: (object: {
    group: string;
    kind: string;
    namespace: string | null;
    name: string;
  }) => Delivery[];
  isPending: boolean;
  /**
   * Set where a controller is installed and did not answer. Saying so is the
   * difference between "nothing delivers this" and "the app could not tell",
   * and the reader cannot infer which from silence.
   */
  error: Error | null;
}

const NONE: Delivery[] = [];

export function useDeliveries(objects: DeliveryQuery[]): Deliveries {
  const providers = useCapabilities("delivery.source");

  // The array identity churns on every render of every caller that builds it
  // inline, and a query key that churned with it would refetch for ever.
  //
  // The digest covers the claim as well as the identity, and it has to. A
  // delivery answer is computed from an object's labels and annotations, and
  // the app has two surfaces that hold the *same* object with different
  // metadata: a list row typed from `StatefulSetInfo`, which carries no labels
  // at all, and the peek over that row, which fetched the full object and has
  // them. Keyed by identity alone the second one reads the first one's cached
  // "nothing delivers this" and a peek's Scale dialog goes quiet about the
  // Argo CD that will undo the number — while the detail page, one route away,
  // says it. That silence is the exact belief this feature exists to prevent.
  const { keys, digest } = useMemo(
    () => ({
      keys: objects.map((object) => deliveryKey(object)),
      digest: deliveryDigest(objects),
    }),
    [objects]
  );

  const results = useQueries({
    queries: providers.map((ask, index) => ({
      queryKey: ["delivery", index, keys.length, digest],
      queryFn: () => ask(objects),
      enabled: keys.length > 0,
      staleTime: STALE,
    })),
  });

  const byKey = new Map<string, Delivery[]>();
  for (const result of results) {
    if (!result.data) continue;
    result.data.forEach((delivery, position) => {
      if (!delivery) return;
      const key = keys[position];
      const list = byKey.get(key);
      if (list) list.push(delivery);
      else byKey.set(key, [delivery]);
    });
  }

  return {
    available: providers.length > 0,
    of: (object) => byKey.get(deliveryKey(object)) ?? NONE,
    isPending: results.some((result) => result.isPending),
    error: (results.find((result) => result.error)?.error as Error) ?? null,
  };
}

/** The same question about one object, which is what a detail page asks. */
export function useDelivery(object: DeliveryQuery | null): {
  available: boolean;
  deliveries: Delivery[];
  isPending: boolean;
  error: Error | null;
} {
  const objects = useMemo(() => (object ? [object] : []), [object]);
  const { available, of, isPending, error } = useDeliveries(objects);
  return {
    available,
    deliveries: object ? of(object) : NONE,
    isPending,
    error,
  };
}

/** What two reads of the same objects have to agree on to share an answer. */
export function deliveryDigest(objects: DeliveryQuery[]): string {
  return digestOf([
    ...objects.map((object) => deliveryKey(object)),
    ...objects.map(claimOf),
  ]);
}

/**
 * The metadata a delivery answer is actually computed from.
 *
 * Every vendor's claim is a label or an annotation, so the whole of both is
 * what changes the answer. Sorted, because a record's key order is the order
 * the API server happened to serialise it in and two orderings of the same
 * labels are the same object.
 */
function claimOf(object: DeliveryQuery): string {
  const pairs = (record: Record<string, string> | undefined) =>
    Object.entries(record ?? {})
      .map(([key, value]) => `${key}=${value}`)
      .sort()
      .join(",");
  return `${pairs(object.labels)};${pairs(object.annotations)}`;
}

/** FNV-1a, because the alternative is a twenty-kilobyte query key. */
function digestOf(parts: string[]): string {
  let hash = 2166136261;
  for (const part of parts) {
    for (let index = 0; index < part.length; index += 1) {
      hash ^= part.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
  }
  return (hash >>> 0).toString(36);
}

/**
 * What each destructive control on a page should say, or `null` for all of
 * them.
 *
 * One hook per page rather than one per button: the answer is about the
 * object, not about the verb, and the verb only changes the words.
 */
export function useDeliveryIntercept(
  object: DeliveryQuery | null
): (verb: string) => DeliveryIntercept | null {
  const t = useT();
  const { deliveries } = useDelivery(object);
  return (verb: string) => deliveryIntercept(deliveries, verb, t);
}
