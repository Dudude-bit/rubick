/**
 * Which Application owns an object in this cluster, resolved rather than
 * trusted.
 *
 * Argo stamps `argocd.argoproj.io/instance` on everything it applies, and
 * that label is the *claim*, not the fact: a manifest committed with the label
 * already on it, a copy-pasted YAML, or an Application that was deleted while
 * its objects were left behind all produce an object that says it is managed
 * and is not. So the label is used only to find the candidate, and the
 * candidate's own `status.resources` has to name the object back before this
 * says anybody owns it.
 *
 * Nothing calls this yet, deliberately. It is the Argo half of the eventual
 * `delivery.source` capability — the "managed by" line on an object's own page
 * — and it lives here, in the vendor's folder, so that wiring it up is adding
 * a key to `provides` and nothing else. See {@link DeliverySource}.
 */

import { commands } from "@/lib/commands";
import { crdObjectPath } from "../kit";
import type { DeliverySource } from "../gitops";
import { APPLICATIONS_CRD } from "./data";
import { readApplication } from "./model";

/** What Argo writes on every object it applies. */
export const INSTANCE_LABEL = "argocd.argoproj.io/instance";
/**
 * The newer form, which carries the whole identity rather than just a name:
 * `<app>:<group>/<kind>:<namespace>/<name>`. Preferred where present, because
 * the label alone is truncated to 63 characters and collides.
 */
export const TRACKING_ANNOTATION = "argocd.argoproj.io/tracking-id";

export interface ManagedObject {
  kind: string;
  name: string;
  namespace: string | null;
  labels: Record<string, string>;
  annotations: Record<string, string>;
}

export async function ownerOf(
  object: ManagedObject
): Promise<DeliverySource | null> {
  const claimed = claimedApplication(object);
  if (!claimed) return null;

  // Argo may run its Applications in any namespace, and an object never
  // records which — so the candidates are every Application by that name.
  const applications = await commands.listCustomResources(
    APPLICATIONS_CRD,
    null,
    null,
    null
  );
  const owner = applications
    .filter((candidate) => candidate.name === claimed)
    .map(readApplication)
    .find((app) =>
      app.resources.some(
        (resource) =>
          resource.kind === object.kind &&
          resource.name === object.name &&
          (resource.namespace ?? null) === (object.namespace ?? null)
      )
    );
  if (!owner) return null;

  const source = owner.sources[0] ?? null;
  return {
    vendor: "Argo CD",
    owner: {
      kind: "Application",
      name: owner.name,
      namespace: owner.namespace,
      to: crdObjectPath(APPLICATIONS_CRD, owner.namespace, owner.name),
    },
    revision: owner.revision,
    repoUrl: source?.repoUrl ?? null,
    // Auto-sync alone re-applies on a *git* change; only self-heal watches the
    // cluster and puts a hand edit back. Saying "your change will be reverted"
    // for an Application without it would be a warning about something that
    // does not happen.
    drift: owner.selfHeal ? "reverted" : "kept",
    note: owner.selfHeal
      ? "Argo self-heals this Application: an edit made here is put back on its next comparison, within about three minutes."
      : owner.autoSync
        ? "Auto-sync is on but self-heal is off, so an edit here stands until the next commit touches this object."
        : "Auto-sync is off, so an edit here stands until somebody syncs the Application.",
  };
}

/** The Application an object says applied it, from the newer form first. */
function claimedApplication(object: ManagedObject): string | null {
  const tracking = object.annotations[TRACKING_ANNOTATION];
  if (tracking) {
    const name = tracking.split(":")[0];
    if (name) return name;
  }
  return object.labels[INSTANCE_LABEL] ?? null;
}
