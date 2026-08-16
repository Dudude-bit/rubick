/**
 * What a Flux reconciler is connected to: where it reads from, and what it
 * will not start without.
 *
 * `dependsOn` is the edge worth the most here and the one nothing else can
 * draw. A `Kustomization` that is not applying because a *different*
 * Kustomization has not become ready reports nothing wrong with itself — the
 * fault is one object away, and the only place it is written down is this
 * list. `./model.ts` already explains why that ordering is real.
 *
 * The inventory — the objects a Kustomization actually applied — is
 * deliberately not here. Flux records it as a count and a hash-keyed
 * `status.inventory`, and a reconciler's own row already carries the count;
 * expanding it into edges would mean re-deriving the whole inventory shape in
 * a second place, and the page is where that belongs.
 */

import type { RelatedObject } from "../registry";
import { fetchPicture, SOURCE_KINDS } from "./data";
import type { FluxReconciler, SourceRef } from "./model";

/**
 * The groups Flux's reconcilers live in. Named rather than pattern-matched on
 * `toolkit.fluxcd.io`: the source group is Flux's too and its kinds are the
 * far end of these edges, not the near one.
 */
const RECONCILER_GROUPS = new Set([
  "kustomize.toolkit.fluxcd.io",
  "helm.toolkit.fluxcd.io",
]);

/** `GitRepository` → `source.toolkit.fluxcd.io`, from the CRD names. */
const SOURCE_GROUP = new Map(
  SOURCE_KINDS.map(([kind, crd]) => [kind, crd.split(".").slice(1).join(".")])
);

function ref(
  relation: string,
  source: SourceRef,
  fallbackGroup: string
): RelatedObject {
  return {
    relation,
    kind: source.kind,
    name: source.name,
    namespace: source.namespace,
    group: SOURCE_GROUP.get(source.kind) ?? fallbackGroup,
  };
}

export async function relatedTo(subject: {
  group: string;
  kind: string;
  namespace: string | null;
  name: string;
}): Promise<RelatedObject[] | null> {
  if (!RECONCILER_GROUPS.has(subject.group)) return null;

  const picture = await fetchPicture();
  const reconciler = picture.reconcilers.find(
    (candidate: FluxReconciler) =>
      candidate.kind === subject.kind &&
      candidate.name === subject.name &&
      candidate.namespace === subject.namespace
  );
  if (!reconciler) return [];

  return [
    ...(reconciler.sourceRef
      ? [ref("reads from", reconciler.sourceRef, subject.group)]
      : []),
    // A dependency is another reconciler in the same group as this one, which
    // is why the subject's group is the fallback: `dependsOn` names a kind
    // and a namespace and no group at all.
    ...reconciler.dependsOn.map((dependency) =>
      ref("waits for", dependency, subject.group)
    ),
  ];
}
