/**
 * Which Kustomization or HelmRelease owns an object, resolved rather than
 * trusted.
 *
 * Flux labels everything it applies with the reconciler's name and namespace,
 * and the label is the *claim*, not the fact: a manifest committed with those
 * labels already on it, or a Kustomization that was deleted with `prune: false`
 * and left its objects behind, both produce an object that says it is managed
 * and is not. So the label finds the candidate and the candidate's own
 * `status.inventory` has to name the object back.
 *
 * Nothing calls this yet, deliberately. It is the Flux half of the eventual
 * `delivery.source` capability — the "managed by" line on an object's own page
 * — and it lives here so that wiring it up is adding a key to `provides` and
 * nothing else. See {@link DeliverySource}.
 */

import { commands } from "@/lib/commands";
import { crdObjectPath, getValueByPath } from "../kit";
import type { DeliverySource } from "../gitops";
import { HELM_RELEASES_CRD, KUSTOMIZATIONS_CRD } from "./data";
import { readRevision, revisionText } from "./model";

export const KUSTOMIZE_NAME_LABEL = "kustomize.toolkit.fluxcd.io/name";
export const KUSTOMIZE_NAMESPACE_LABEL =
  "kustomize.toolkit.fluxcd.io/namespace";
export const HELM_NAME_LABEL = "helm.toolkit.fluxcd.io/name";
export const HELM_NAMESPACE_LABEL = "helm.toolkit.fluxcd.io/namespace";

export interface ManagedObject {
  /** As Flux writes it in an inventory entry: the API group, or "" for core. */
  group: string;
  kind: string;
  name: string;
  namespace: string | null;
  labels: Record<string, string>;
}

export async function ownerOf(
  object: ManagedObject
): Promise<DeliverySource | null> {
  const kustomization = object.labels[KUSTOMIZE_NAME_LABEL];
  if (kustomization) {
    return kustomizationOwner(
      object,
      kustomization,
      object.labels[KUSTOMIZE_NAMESPACE_LABEL] ?? ""
    );
  }
  const release = object.labels[HELM_NAME_LABEL];
  if (release) {
    return helmOwner(release, object.labels[HELM_NAMESPACE_LABEL] ?? "");
  }
  return null;
}

async function kustomizationOwner(
  object: ManagedObject,
  name: string,
  namespace: string
): Promise<DeliverySource | null> {
  const objects = await commands.listCustomResources(
    KUSTOMIZATIONS_CRD,
    namespace || null,
    null,
    null
  );
  const owner = objects.find(
    (candidate) =>
      candidate.name === name && (candidate.namespace ?? "") === namespace
  );
  if (!owner) return null;

  // `namespace_name_group_kind`, which is Flux's own object id and the only
  // statement that this Kustomization really applied this object.
  const wanted = `${object.namespace ?? ""}_${object.name}_${object.group}_${object.kind}`;
  const entries = (getValueByPath(owner, "status.inventory.entries") ??
    []) as Array<{ id?: string }>;
  if (!entries.some((entry) => entry.id === wanted)) return null;

  const suspended = getValueByPath(owner, "spec.suspend") === true;
  const revision = readRevision(
    (getValueByPath(owner, "status.lastAppliedRevision") as string) ?? null
  );
  // Flux reverts a hand edit only where it is told to. Without `prune` and
  // with `force` off it still re-applies its own fields on every reconcile,
  // which is what actually undoes a `kubectl edit`.
  return {
    vendor: "Flux",
    owner: {
      kind: "Kustomization",
      name: owner.name,
      namespace: owner.namespace ?? "",
      to: crdObjectPath(KUSTOMIZATIONS_CRD, owner.namespace, owner.name),
    },
    revision: revision ? revisionText(revision) : null,
    repoUrl: null,
    drift: suspended ? "unmanaged" : "reverted",
    note: suspended
      ? `${owner.name} is suspended, so nothing is being applied and an edit here stands — until somebody resumes it, at which point it is undone.`
      : `${owner.name} re-applies its manifests every ${getValueByPath(owner, "spec.interval") ?? "interval"}, so an edit here is undone on the next reconcile.`,
  };
}

async function helmOwner(
  name: string,
  namespace: string
): Promise<DeliverySource | null> {
  const objects = await commands.listCustomResources(
    HELM_RELEASES_CRD,
    namespace || null,
    null,
    null
  );
  const owner = objects.find(
    (candidate) =>
      candidate.name === name && (candidate.namespace ?? "") === namespace
  );
  // A HelmRelease keeps no inventory — what it owns is in Helm's own release
  // storage — so the label is as far as this can resolve, and the claim is
  // narrowed by the release existing and naming the same namespace.
  if (!owner) return null;

  const suspended = getValueByPath(owner, "spec.suspend") === true;
  return {
    vendor: "Flux",
    owner: {
      kind: "HelmRelease",
      name: owner.name,
      namespace: owner.namespace ?? "",
      to: crdObjectPath(HELM_RELEASES_CRD, owner.namespace, owner.name),
    },
    revision:
      (getValueByPath(owner, "status.history[0].chartVersion") as string) ??
      null,
    repoUrl: null,
    drift: suspended ? "unmanaged" : "reverted",
    note: suspended
      ? `${owner.name} is suspended, so an edit here stands until somebody resumes it.`
      : `${owner.name} upgrades the release on its interval, and a hand edit is replaced by the chart's own value.`,
  };
}
