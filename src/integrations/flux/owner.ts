/**
 * Which Kustomization or HelmRelease delivers an object, resolved rather than
 * trusted.
 *
 * Flux labels everything it applies with the reconciler's name, and the label
 * is the claim, not the fact: a manifest committed with those labels already
 * on it, or a Kustomization deleted with `prune: false`, both leave an object
 * that says it is managed and is not. So the label finds the candidate and the
 * candidate's own `status.inventory` has to name the object back; where it
 * does not, the answer is {@link Delivery} `state: "claimed"`.
 *
 * **Flux has no per-object drift**, unlike Argo: a Kustomization re-applies
 * its own fields on its interval and the correction is silent, so nothing
 * records that anything had differed and {@link DeliverySource.sync} is `null`
 * for every Flux-delivered object — nobody knows, not a quiet tick. What Flux
 * does publish is whether the reconciler runs at all: a suspended
 * Kustomization, or one whose source stopped fetching, keeps `Ready=True`
 * while applying nothing, and that is {@link DeliverySource.warning}.
 *
 * Takes a list for the same reason Argo's does: one read of the reconcilers
 * answers a five-hundred-row page.
 */
import { commands } from "@/lib/commands";
import { crdObjectPath, conditionOf, getValueByPath } from "../kit";
import type { T } from "@/i18n/useT";
import type {
  Delivery,
  DeliveryOwner,
  DeliveryQuery,
  DeliverySource,
  Saying,
} from "../gitops";
import type { CustomResourceInfo } from "@/generated/types";
import { HELM_RELEASES_CRD, KUSTOMIZATIONS_CRD } from "./data";
import { readRevision, revisionText } from "./model";

export const KUSTOMIZE_NAME_LABEL = "kustomize.toolkit.fluxcd.io/name";
export const KUSTOMIZE_NAMESPACE_LABEL =
  "kustomize.toolkit.fluxcd.io/namespace";
export const HELM_NAME_LABEL = "helm.toolkit.fluxcd.io/name";
export const HELM_NAMESPACE_LABEL = "helm.toolkit.fluxcd.io/namespace";

const VENDOR = "Flux";
const VENDOR_ID = "flux";

interface Claim {
  kind: "Kustomization" | "HelmRelease";
  name: string;
  namespace: string;
}

/** Positional, and `null` where the object carries no Flux label at all. */
export async function ownerOf(
  objects: DeliveryQuery[]
): Promise<Array<Delivery | null>> {
  const claims = objects.map(claimOf);
  const wantsKustomizations = claims.some(
    (claim) => claim?.kind === "Kustomization"
  );
  const wantsReleases = claims.some((claim) => claim?.kind === "HelmRelease");
  if (!wantsKustomizations && !wantsReleases) {
    return objects.map(() => null);
  }

  // Only the kinds something actually claimed, cluster-wide and once: an
  // object records the reconciler's namespace, but reading each namespace
  // separately would put a call per distinct owner on a page that needs one.
  const [kustomizations, releases] = await Promise.all([
    wantsKustomizations ? listAll(KUSTOMIZATIONS_CRD) : [],
    wantsReleases ? listAll(HELM_RELEASES_CRD) : [],
  ]);
  const owners = new Map<string, CustomResourceInfo>();
  for (const owner of [...kustomizations, ...releases]) {
    owners.set(`${owner.kind}/${owner.namespace ?? ""}/${owner.name}`, owner);
  }

  const inventories = new Map<CustomResourceInfo, Set<string>>();
  const inventoryOf = (owner: CustomResourceInfo) => {
    let entries = inventories.get(owner);
    if (!entries) {
      entries = new Set(
        (
          (getValueByPath(owner, "status.inventory.entries") ?? []) as Array<{
            id?: string;
          }>
        ).flatMap((entry) => (entry.id ? [entry.id] : []))
      );
      inventories.set(owner, entries);
    }
    return entries;
  };

  return objects.map((object, position) => {
    const claim = claims[position];
    if (!claim) return null;

    const owner = owners.get(`${claim.kind}/${claim.namespace}/${claim.name}`);
    const disowned = {
      state: "claimed",
      vendor: VENDOR,
      vendorId: VENDOR_ID,
      claim: claim.name,
      ownerKind: claim.kind,
      owner: owner ? ownerRef(claim.kind, owner) : null,
    } as const;
    if (!owner) return disowned;

    if (claim.kind === "Kustomization") {
      // `namespace_name_group_kind` is Flux's own object id and the only
      // statement that this Kustomization really applied this object.
      const id = `${object.namespace ?? ""}_${object.name}_${object.group}_${object.kind}`;
      if (!inventoryOf(owner).has(id)) return disowned;
      return { state: "delivered", source: kustomizationSource(owner) };
    }
    // A HelmRelease keeps no inventory — what it owns is in Helm's own release
    // storage — so the label is as far as this can resolve, and the claim is
    // narrowed by the release existing and naming the same namespace.
    return { state: "delivered", source: releaseSource(owner) };
  });
}

function listAll(crd: string): Promise<CustomResourceInfo[]> {
  return commands
    .listCustomResources(crd, null, null, null)
    .catch((): CustomResourceInfo[] => []);
}

function claimOf(object: DeliveryQuery): Claim | null {
  const kustomization = object.labels[KUSTOMIZE_NAME_LABEL];
  if (kustomization) {
    return {
      kind: "Kustomization",
      name: kustomization,
      namespace: object.labels[KUSTOMIZE_NAMESPACE_LABEL] ?? "",
    };
  }
  const release = object.labels[HELM_NAME_LABEL];
  if (release) {
    return {
      kind: "HelmRelease",
      name: release,
      namespace: object.labels[HELM_NAMESPACE_LABEL] ?? "",
    };
  }
  return null;
}

function ownerRef(
  kind: Claim["kind"],
  owner: CustomResourceInfo
): DeliveryOwner {
  const crd = kind === "Kustomization" ? KUSTOMIZATIONS_CRD : HELM_RELEASES_CRD;
  return {
    kind,
    name: owner.name,
    namespace: owner.namespace ?? "",
    to: crdObjectPath(crd, owner.namespace, owner.name),
  };
}

/** A translator for the branches that provably take no words. */
const noWords: T = () => "";

/**
 * A reconciler that is not reconciling, in the two shapes Flux has for it.
 *
 * `Ready` is not the question: a suspended Kustomization and one whose source
 * stopped fetching both keep `Ready=True` from the last run that worked, which
 * is the state that looks perfect and is why this is read separately.
 */
function stalledReason(owner: CustomResourceInfo): Saying | null {
  if (getValueByPath(owner, "spec.suspend") === true)
    return { key: "fluxSuspendedWord" };
  const ready = conditionOf(owner, "Ready");
  if (ready?.status === "False") return { key: "fluxNotReconcilingWord" };
  const stalled = conditionOf(owner, "Stalled");
  if (stalled?.status === "True") return { key: "fluxNotReconcilingWord" };
  return null;
}

function kustomizationSource(owner: CustomResourceInfo): DeliverySource {
  const stalled = stalledReason(owner);
  const revision = readRevision(
    (getValueByPath(owner, "status.lastAppliedRevision") as string) ?? null
  );
  const interval = (getValueByPath(owner, "spec.interval") as string) ?? null;
  return {
    vendor: VENDOR,
    vendorId: VENDOR_ID,
    owner: ownerRef("Kustomization", owner),
    // `revisionText` only reaches for a word when there is no revision, and
    // the guard above means there is one.
    revision: revision ? revisionText(revision, noWords) : null,
    repoUrl: null,
    path: (getValueByPath(owner, "spec.path") as string) ?? null,
    // Flux does not diff; it re-applies its own fields on every reconcile,
    // which is what actually undoes a `kubectl edit`.
    drift: stalled ? "unmanaged" : "reverted",
    sync: null,
    lastAppliedAt:
      (conditionOf(owner, "Ready")?.lastTransitionTime as string) ?? null,
    warning: stalled,
    note:
      stalled?.key === "fluxSuspendedWord"
        ? { key: "fluxKustSuspended" as const, values: { name: owner.name } }
        : stalled
          ? { key: "fluxKustStopped" as const, values: { name: owner.name } }
          : {
              key: "fluxKustReapplies" as const,
              values: { name: owner.name, interval: interval ?? "interval" },
            },
  };
}

function releaseSource(owner: CustomResourceInfo): DeliverySource {
  const stalled = stalledReason(owner);
  return {
    vendor: VENDOR,
    vendorId: VENDOR_ID,
    owner: ownerRef("HelmRelease", owner),
    revision:
      (getValueByPath(owner, "status.history[0].chartVersion") as string) ??
      null,
    repoUrl: null,
    path: null,
    drift: stalled ? "unmanaged" : "reverted",
    sync: null,
    lastAppliedAt:
      (conditionOf(owner, "Ready")?.lastTransitionTime as string) ?? null,
    warning: stalled,
    note:
      stalled?.key === "fluxSuspendedWord"
        ? { key: "fluxRelSuspended" as const, values: { name: owner.name } }
        : stalled
          ? { key: "fluxRelStopped" as const, values: { name: owner.name } }
          : { key: "fluxRelUpgrades" as const, values: { name: owner.name } },
  };
}
