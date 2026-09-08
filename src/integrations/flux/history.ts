import { commands } from "@/lib/commands";
import { conditionOf, getValueByPath } from "../kit";
import type { DeliveryOwner, DeliveryRevision } from "../gitops";
import { HELM_RELEASES_CRD, KUSTOMIZATIONS_CRD } from "./data";

interface ReleaseSnapshot {
  version?: number;
  chartName?: string;
  chartVersion?: string;
  status?: string;
  lastDeployed?: string;
  firstDeployed?: string;
}

/**
 * A HelmRelease keeps `status.history`; a Kustomization keeps only the
 * revision it last applied, so its history is one entry, dated by the
 * `Ready` condition's last transition rather than by anything it wrote
 * about the apply itself.
 */
export async function historyOf(
  owner: DeliveryOwner
): Promise<DeliveryRevision[] | null> {
  if (owner.kind === "HelmRelease") {
    const release = await commands.getCustomResource(
      HELM_RELEASES_CRD,
      owner.name,
      owner.namespace
    );
    const history = getValueByPath(release, "status.history");
    const snapshots = Array.isArray(history)
      ? (history as ReleaseSnapshot[])
      : [];
    return snapshots.map((snapshot, index) => ({
      id: `${owner.namespace}/${owner.name}/${snapshot.version ?? index}`,
      at: snapshot.lastDeployed ?? snapshot.firstDeployed ?? null,
      revision: snapshot.chartVersion ?? null,
      from: snapshot.chartName ?? null,
      status: snapshot.status ?? null,
      owner,
    }));
  }
  if (owner.kind === "Kustomization") {
    const kustomization = await commands.getCustomResource(
      KUSTOMIZATIONS_CRD,
      owner.name,
      owner.namespace
    );
    const applied = getValueByPath(
      kustomization,
      "status.lastAppliedRevision"
    ) as string | undefined;
    if (!applied) return [];
    const ready = conditionOf(kustomization, "Ready");
    return [
      {
        id: `${owner.namespace}/${owner.name}/${applied}`,
        at: ready?.lastTransitionTime ?? null,
        revision: applied,
        from: (getValueByPath(kustomization, "spec.path") as string) ?? null,
        status: ready?.status === "True" ? "applied" : (ready?.reason ?? null),
        owner,
      },
    ];
  }
  return null;
}
