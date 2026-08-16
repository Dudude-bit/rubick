/**
 * What a custom resource is connected to: what its own controller says, plus
 * the one edge Kubernetes guarantees.
 *
 * Two sources with two different standings, and the surface owes the reader
 * the difference. `metadata.ownerReferences` is upstream Kubernetes and is
 * true of every object on every cluster — this app reads it directly. Anything
 * else a custom resource points at is the operator's own vocabulary, and only
 * a vendor can read it: see `object.related`.
 *
 * Where no vendor claims the kind, the owner edge is still drawn and the
 * surface says plainly that nothing here knows more. That is the whole of the
 * discipline this hook exists to keep — a tab that showed only the owner
 * reference and no caveat would be stating that an Argo Application manages
 * nothing.
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { useCapabilities, type RelatedObject } from "@/integrations";
import { groupOf, useCrdIndex } from "@/hooks/useCrdIndex";
import type { CustomResourceDetailInfo } from "@/generated/types";

/** A related object with its address worked out, which is what a row needs. */
export interface RelatedRef extends RelatedObject {
  /** The CRD defining the far end, where it is a custom resource. */
  crd?: string;
}

export interface RelatedObjects {
  /**
   * Whether any vendor in this app can speak for this kind.
   *
   * `false` is the ordinary answer for most CRDs on most clusters — a
   * `ServiceMonitor`, a `SealedSecret`, anything an operator nobody wrote an
   * integration for installed. The surface must say so rather than draw an
   * empty list, which would read as "this object is connected to nothing".
   */
  claimed: boolean;
  /** What the controller states, and what owns the object. Owners first. */
  related: RelatedRef[];
  isPending: boolean;
  /** A vendor that claims the kind and could not answer. */
  error: Error | null;
}

const NONE: RelatedObject[] = [];

/**
 * The one relation that needs no vendor.
 *
 * `metadata.ownerReferences` is upstream Kubernetes and true of every object
 * on every cluster, so it is read here rather than asked of anybody.
 */
function owners(
  resource: CustomResourceDetailInfo | undefined
): RelatedObject[] {
  return (resource?.ownerReferences ?? []).map((owner) => ({
    relation: owner.controller ? "controlled by" : "owned by",
    kind: owner.kind,
    name: owner.name,
    // An owner reference is always in the same namespace as the object; the
    // API server rejects a cross-namespace one.
    namespace: resource?.namespace ?? null,
    group: groupOf(owner.apiVersion),
  }));
}

export function useRelatedObjects(
  subject: {
    group: string;
    kind: string;
    namespace: string | null;
    name: string;
  } | null,
  /** The object itself, for the owner edge. Absent until the read lands. */
  resource?: CustomResourceDetailInfo
): RelatedObjects {
  const suppliers = useCapabilities("object.related");
  const { crdFor } = useCrdIndex();
  const enabled = suppliers.length > 0 && subject !== null;

  const query = useQuery({
    queryKey: [
      "object-related",
      subject?.group ?? "",
      subject?.kind ?? "",
      subject?.namespace ?? "",
      subject?.name ?? "",
      suppliers.length,
    ],
    queryFn: async () => {
      const answers = await Promise.all(suppliers.map((ask) => ask(subject!)));
      const claimed = answers.filter((answer) => answer !== null);
      // `null` from every supplier is "nobody here owns this kind", which the
      // surface has to be able to say. Flattening first would turn it into an
      // empty list, and an empty list is a claim about the object.
      return {
        claimed: claimed.length > 0,
        stated: claimed.flat(),
      };
    },
    enabled,
    // An operator writes its inventory on reconcile, which is minutes apart —
    // and this tab is read, not watched.
    staleTime: 30_000,
  });

  // The address is worked out here rather than by each vendor: turning a
  // group and a kind into a CRD name needs the cluster's own list, and three
  // folders holding that lookup is three chances to disagree about it.
  const related = useMemo(
    () =>
      [...owners(resource), ...(query.data?.stated ?? NONE)].map(
        (entry): RelatedRef => ({
          ...entry,
          crd: crdFor(entry.group, entry.kind) ?? undefined,
        })
      ),
    [resource, query.data, crdFor]
  );

  return {
    claimed: query.data?.claimed ?? false,
    related,
    isPending: enabled && query.isPending,
    error: (query.error as Error) ?? null,
  };
}
