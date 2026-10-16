import { commands } from "@/lib/commands";
import { getValueByPath } from "../kit";
import type { DeliveryOwner, DeliveryRevision } from "../gitops";
import { APPLICATIONS_CRD } from "./data";

interface HistoryEntry {
  id?: number;
  revision?: string;
  deployedAt?: string;
  deployStartedAt?: string;
  source?: { repoURL?: string; path?: string; targetRevision?: string };
}

/** `status.history`, which Argo caps at its own `spec.revisionHistoryLimit`. */
export async function historyOf(
  owner: DeliveryOwner
): Promise<DeliveryRevision[] | null> {
  if (owner.kind !== "Application") return null;
  const app = await commands.getCustomResource(
    APPLICATIONS_CRD,
    owner.name,
    owner.namespace
  );
  const history = getValueByPath(app, "status.history");
  const entries = Array.isArray(history) ? (history as HistoryEntry[]) : [];
  return entries
    .map((entry, index) => ({
      id: `${owner.namespace}/${owner.name}/${entry.id ?? index}`,
      at: entry.deployedAt ?? entry.deployStartedAt ?? null,
      revision: entry.revision ?? null,
      from: entry.source?.path ?? entry.source?.repoURL ?? null,
      status: null,
      owner,
    }))
    .reverse();
}
