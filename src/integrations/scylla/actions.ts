import { commands } from "@/lib/commands";
import type { en } from "@/i18n/catalogue";
import { CLUSTERS_CRD } from "./data";
import type { ScyllaCluster } from "./model";

type OperatorsKey = keyof typeof en.operators;

/** Scylla's real knobs: three spec fields the operator acts on. */
export interface ScyllaAction {
  id: "restart" | "scale" | "upgrade";
  label: OperatorsKey;
  explains: OperatorsKey;
  reason: OperatorsKey | null;
  danger: boolean;
  /** Scale and upgrade take a value from the reader. */
  input?:
    | { kind: "members"; rack: string; current: number }
    | { kind: "version"; current: string | null };
}

export function actionsFor(
  cluster: ScyllaCluster,
  canPatch: boolean | null
): ScyllaAction[] {
  const noPatch: OperatorsKey | null =
    canPatch === false ? "refusedPatchScylla" : null;
  const upgrading: OperatorsKey | null = cluster.upgrade
    ? "notDuringUpgrade"
    : null;
  const list: ScyllaAction[] = [
    {
      id: "restart",
      label: "actionRollingRestart",
      explains: "actionRollingRestartExplained",
      reason: noPatch ?? upgrading,
      danger: true,
    },
  ];
  for (const rack of cluster.racks) {
    list.push({
      id: "scale",
      label: "actionScaleRack",
      explains: "actionScaleRackExplained",
      reason: noPatch ?? upgrading,
      danger: false,
      input: { kind: "members", rack: rack.name, current: rack.members },
    });
  }
  list.push({
    id: "upgrade",
    label: "actionUpgrade",
    explains: "actionUpgradeExplained",
    reason: noPatch ?? upgrading,
    danger: true,
    input: { kind: "version", current: cluster.version },
  });
  return list;
}

/** The merge patch each action sends; exported so a test can read it without a cluster. */
export function patchFor(
  action: ScyllaAction,
  cluster: ScyllaCluster,
  value: string,
  now: Date = new Date()
): Record<string, unknown> {
  switch (action.id) {
    case "restart":
      return {
        spec: { forceRedeploymentReason: `rubick ${now.toISOString()}` },
      };
    case "scale": {
      const input = action.input;
      if (input?.kind !== "members") throw new Error("scale needs a rack");
      const members = Number(value);
      if (!Number.isInteger(members) || members < 0) {
        throw new Error(`members must be a whole number, not ${value}`);
      }
      // Racks are a list, so a merge patch sends the whole list with one
      // number changed; anything less would drop the other racks.
      return {
        spec: {
          datacenter: {
            racks: cluster.racks.map((rack) => ({
              name: rack.name,
              members: rack.name === input.rack ? members : rack.members,
            })),
          },
        },
      };
    }
    case "upgrade": {
      const version = value.trim();
      if (!/^\d+\.\d+/.test(version)) {
        throw new Error(`a ScyllaDB version looks like 2025.2.1, not ${value}`);
      }
      return { spec: { version } };
    }
  }
}

export async function perform(
  action: ScyllaAction,
  cluster: ScyllaCluster,
  value: string
): Promise<void> {
  await commands.patchCustomResource(
    CLUSTERS_CRD,
    cluster.name,
    cluster.namespace,
    patchFor(action, cluster, value)
  );
}
