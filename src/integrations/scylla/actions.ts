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

/**
 * The JSON Patch (RFC 6902) that scales one rack.
 *
 * A merge patch cannot edit one element of a list — it replaces the list —
 * so rebuilding `spec.datacenter.racks` from what this page models deleted
 * every field the model does not carry, from **every** rack. Reproduced
 * against a real apiserver: scaling one rack from 3 to 5 left
 * `[{name, members}]`, and a live ScyllaDB rack also carries `storage`
 * (the volume claim for the data), `resources`, `placement`, `volumes`,
 * `volumeMounts` and both config sections.
 *
 * The `test` op is the other half. It names the rack this index is expected
 * to hold; if the list has changed since the page read it, the apiserver
 * rejects the whole patch rather than resizing somebody else's rack.
 */
export function opsFor(
  action: ScyllaAction,
  cluster: ScyllaCluster,
  value: string
): Array<Record<string, unknown>> {
  const input = action.input;
  if (action.id !== "scale" || input?.kind !== "members") {
    throw new Error(SCALE_IS_A_JSON_PATCH);
  }
  const members = Number(value);
  if (!Number.isInteger(members) || members < 0) {
    throw new Error(`members must be a whole number, not ${value}`);
  }
  const at = cluster.racks.findIndex((rack) => rack.name === input.rack);
  if (at < 0) throw new Error(`no rack named ${input.rack}`);
  return [
    {
      op: "test",
      path: `/spec/datacenter/racks/${at}/name`,
      value: input.rack,
    },
    {
      op: "replace",
      path: `/spec/datacenter/racks/${at}/members`,
      value: members,
    },
  ];
}

const SCALE_IS_A_JSON_PATCH =
  "scaling a rack is a JSON Patch, not a merge patch";

/** The merge patch each action sends; exported so a test can read it without a cluster. */
export function patchFor(
  action: ScyllaAction,
  value: string,
  now: Date = new Date()
): Record<string, unknown> {
  switch (action.id) {
    case "restart":
      return {
        spec: { forceRedeploymentReason: `rubick ${now.toISOString()}` },
      };
    case "scale":
      // Scaling does not go through a merge patch at all — see `opsFor`.
      throw new Error(SCALE_IS_A_JSON_PATCH);
    case "upgrade": {
      const version = value.trim();
      // Anchored at both ends: an unanchored prefix let
      // `2025.2.1; rm -rf` and `2025.2.1-latest-please` through, and the
      // value goes straight into `spec.version` for the operator to pull.
      if (!/^\d+(\.\d+){1,3}$/.test(version)) {
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
  if (action.id === "scale") {
    await commands.patchCustomResourceJson(
      CLUSTERS_CRD,
      cluster.name,
      cluster.namespace,
      opsFor(action, cluster, value)
    );
    return;
  }
  await commands.patchCustomResource(
    CLUSTERS_CRD,
    cluster.name,
    cluster.namespace,
    patchFor(action, value)
  );
}
