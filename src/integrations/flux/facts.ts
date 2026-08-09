/**
 * What Flux is doing for this cluster right now.
 *
 * Kustomizations only, and one list. `kustomize-controller` is what
 * detection keys on, so the CRD this reads is the one whose presence said
 * Flux was here — the call cannot be made against a cluster that would
 * refuse it. Adding HelmReleases would be a second list against a CRD that
 * a source-only install does not have, and a row that says "could not read
 * them" on a working Flux is worse than a row that says one true thing.
 */

import { commands } from "@/lib/commands";

import { crdObjectsPath, plural, readyStatus } from "../kit";
import type { VendorFact } from "../registry";

const KUSTOMIZATIONS_CRD = "kustomizations.kustomize.toolkit.fluxcd.io";

export async function facts(): Promise<VendorFact[]> {
  const kustomizations = await commands.listCustomResources(
    KUSTOMIZATIONS_CRD,
    null,
    null,
    null
  );

  // Not-Ready is Flux's own word for "the cluster does not match git and I
  // could not make it". A Kustomization the controller has not reached yet
  // has no condition at all, which is neither reconciled nor failing.
  const failing = kustomizations.filter(
    (kustomization) => readyStatus(kustomization) === "False"
  );

  const lines: VendorFact[] = [
    { text: plural(kustomizations.length, "Kustomization") },
  ];

  if (failing.length > 0) {
    lines.push({
      text: `${failing.length} not reconciled`,
      tone: "err",
    });
  }
  if (kustomizations.length > 0) {
    lines.push({ text: "Show them", to: crdObjectsPath(KUSTOMIZATIONS_CRD) });
  }

  return lines;
}
