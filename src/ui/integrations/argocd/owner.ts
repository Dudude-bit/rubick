/**
 * Which Application delivers an object in this cluster, resolved rather than
 * trusted.
 *
 * Argo stamps `argocd.argoproj.io/instance` on everything it applies, and that
 * label is the *claim*, not the fact: a manifest committed with the label
 * already on it, a copy-pasted YAML, or an Application that was deleted while
 * its objects were left behind all produce an object that says it is managed
 * and is not. So the label is used only to find the candidate, and the
 * candidate's own `status.resources` has to name the object back before this
 * reports delivery. Where it does not, the answer is
 * {@link Delivery} `state: "claimed"` — the app says what the object claims and
 * that nothing confirms it, which is a fact of its own and not a `null`.
 *
 * ## Why it takes a list
 *
 * Because a Deployments page holds five hundred rows and Argo's answer for all
 * of them is in **one** read. The label is already on every object the list
 * fetched, so the claim costs nothing; the Applications are listed once, keyed
 * once, and every row is then a map lookup. A per-object entry point would have
 * been an honest-looking signature that made the column impossible.
 */

import { commands } from "@/lib/commands";
import { objectLink } from "@/lib/links";
import {
  deliveryKey,
  type Delivery,
  type DeliveryOwner,
  type DeliveryQuery,
} from "../gitops";
import { APPLICATIONS_CRD } from "./data";
import { readApplication, type ArgoApp, type ArgoResource } from "./model";

/** What Argo writes on every object it applies, where its Helm chart set the key. */
export const INSTANCE_LABEL = "argocd.argoproj.io/instance";
/**
 * The key Argo itself defaults to with label tracking, as installed from its
 * plain manifests. Every Helm chart writes its release name under it too, so
 * alone it finds a candidate and is never a claim: see {@link Claim.own}.
 */
const SHARED_INSTANCE_LABEL = "app.kubernetes.io/instance";
/**
 * The newer form, which carries the whole identity rather than just a name:
 * `<app>:<group>/<kind>:<namespace>/<name>`. Preferred where present, because
 * the label alone is truncated to 63 characters and collides.
 */
export const TRACKING_ANNOTATION = "argocd.argoproj.io/tracking-id";

const VENDOR_ID = "argocd";
const VENDOR = "Argo CD";
const OWNER_KIND = "Application";

/**
 * Answers positionally: `result[i]` is about `objects[i]`, and `null` means
 * the object carries no Argo claim at all — which is most objects on most
 * clusters and is not a failure.
 */
export async function ownerOf(
  objects: DeliveryQuery[]
): Promise<Array<Delivery | null>> {
  const claims = objects.map(claimedApplication);
  // Nothing claims Argo, so nothing is read. A namespace of hand-applied
  // objects costs one label lookup each and no call at all.
  if (claims.every((claim) => claim === null)) return objects.map(() => null);

  const applications = (
    await commands.listCustomResources(APPLICATIONS_CRD, null, null, null)
  ).map(readApplication);

  // A claim names the namespace of an Application outside Argo's own, and
  // only then: a bare name is every Application answering to it.
  const byName = new Map<string, ArgoApp[]>();
  for (const app of applications) {
    const found = byName.get(app.name);
    if (found) found.push(app);
    else byName.set(app.name, [app]);
  }

  const owned = new Map<ArgoApp, Map<string, ArgoResource>>();
  const resourcesOf = (app: ArgoApp) => {
    let index = owned.get(app);
    if (!index) {
      index = new Map(
        app.resources.map((resource) => [resourceKey(resource), resource])
      );
      owned.set(app, index);
    }
    return index;
  };

  return objects.map((object, position) => {
    const claim = claims[position];
    if (!claim) return null;

    const candidates = (byName.get(claim.name) ?? []).filter(
      (app) => claim.namespace === null || app.namespace === claim.namespace
    );
    const wanted = deliveryKey({
      group: "",
      kind: object.kind,
      namespace: object.namespace,
      name: object.name,
    });
    for (const app of candidates) {
      const resource = resourcesOf(app).get(wanted);
      if (resource) {
        return { state: "delivered", source: sourceOf(app, resource) } as const;
      }
    }
    // A chart's release label that no Application confirms says nothing
    // about Argo, and calling it disowned would mark every Helm install.
    if (!claim.own) return null;
    return {
      state: "claimed",
      vendor: VENDOR,
      vendorId: VENDOR_ID,
      claim: claim.said,
      ownerKind: OWNER_KIND,
      owner: candidates[0] ? ownerRef(candidates[0]) : null,
    } as const;
  });
}

/**
 * Kind, namespace and name, and deliberately not the API group.
 *
 * Argo spells the group of a core object as an absent field and of everything
 * else as the group alone, while the caller holds whatever its own list type
 * happens to carry — and a mismatch there would not read as "could not tell",
 * it would read as *labelled and disowned*, which is the loudest thing this
 * file can say. Two kinds with the same name in the same namespace under
 * different groups is the collision this gives up, and it is rarer than the
 * spelling disagreement it avoids.
 */
function resourceKey(resource: ArgoResource): string {
  return deliveryKey({
    group: "",
    kind: resource.kind,
    namespace: resource.namespace,
    name: resource.name,
  });
}

function ownerRef(app: ArgoApp): DeliveryOwner {
  return {
    kind: OWNER_KIND,
    name: app.name,
    namespace: app.namespace,
    to: objectLink({
      kind: OWNER_KIND,
      name: app.name,
      namespace: app.namespace,
      crd: APPLICATIONS_CRD,
    })!,
  };
}

function sourceOf(app: ArgoApp, resource: ArgoResource) {
  const source = app.sources[0] ?? null;
  // An Application that cannot compare against its repository is not applying
  // anything, which is a different answer from "an edit here is kept": it
  // starts reverting again the moment somebody fixes the repository.
  const stalled = app.sync === "Unknown";
  const failing = app.findings.some(
    (finding) =>
      finding.kind === "syncFailing" || finding.kind === "syncFailedOnce"
  );
  const outOfSync = resource.sync !== null && resource.sync !== "Synced";

  return {
    vendor: VENDOR,
    vendorId: VENDOR_ID,
    owner: ownerRef(app),
    revision: app.revision,
    repoUrl: source?.repoUrl ?? null,
    path: source?.path ?? null,
    // Auto-sync alone re-applies on a *git* change; only self-heal watches the
    // cluster and puts a hand edit back. Saying "your change will be reverted"
    // for an Application without it would be a warning about something that
    // does not happen.
    drift: stalled ? "unmanaged" : app.selfHeal ? "reverted" : "kept",
    sync: resource.sync === null ? null : outOfSync ? "drifted" : "synced",
    lastAppliedAt: app.lastSyncAt,
    warning: outOfSync
      ? { key: "argoOutOfSync" as const }
      : stalled
        ? { key: "argoNotComparing" as const }
        : failing
          ? { key: "argoSyncFailing" as const }
          : null,
    note: stalled
      ? { key: "argoCannotCompare" as const, values: { name: app.name } }
      : app.selfHeal
        ? { key: "argoSelfHeals" as const }
        : app.autoSync
          ? { key: "argoAutoSyncNoHeal" as const }
          : { key: "argoNoAutoSync" as const },
  } as const;
}

interface Claim {
  /** The instance name as the object spells it. */
  said: string;
  name: string;
  /** Where the Application is, for one outside Argo's own namespace. */
  namespace: string | null;
  /** Written under a key only Argo uses, so unconfirmed it is still a claim. */
  own: boolean;
}

/**
 * The Application an object says applied it, from the newer form first.
 *
 * Argo names an Application outside its own namespace `<namespace>_<name>`,
 * and no Kubernetes name holds an underscore, so the first one divides them.
 */
function claimedApplication(object: DeliveryQuery): Claim | null {
  const tracking = object.annotations[TRACKING_ANNOTATION]?.split(":")[0];
  const own = tracking || object.labels[INSTANCE_LABEL];
  const said = own || object.labels[SHARED_INSTANCE_LABEL];
  if (!said) return null;
  const cut = said.indexOf("_");
  return {
    said,
    name: said.slice(cut + 1),
    namespace: cut === -1 ? null : said.slice(0, cut),
    own: Boolean(own),
  };
}
