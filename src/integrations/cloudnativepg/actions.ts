import { commands } from "@/lib/commands";
import type { en } from "@/i18n/catalogue";
import { BACKUPS_CRD, CLUSTERS_CRD } from "./data";
import {
  FENCED,
  HIBERNATION,
  RELOADED_AT,
  RESTARTED_AT,
  type PgCluster,
} from "./model";

type OperatorsKey = keyof typeof en.operators;

/**
 * CNPG's real knobs, each an annotation or an object, each described by
 * what the operator will then do. Nothing here is invented: every knob is
 * the one the `cnpg` kubectl plugin turns.
 */
export interface PgAction {
  id:
    | "restart"
    | "reload"
    | "backup"
    | "fence"
    | "unfence"
    | "hibernate"
    | "wake";
  label: OperatorsKey;
  explains: OperatorsKey;
  /** Why it cannot run on this cluster as it stands; the control stays and says so. */
  reason: OperatorsKey | null;
  danger: boolean;
  /** For fence: the instance to stop. */
  instance?: string;
}

export interface Allowed {
  patchClusters: boolean | null;
  createBackups: boolean | null;
}

export function actionsFor(cluster: PgCluster, allowed: Allowed): PgAction[] {
  const noPatch: OperatorsKey | null =
    allowed.patchClusters === false ? "refusedPatch" : null;
  const noCreate: OperatorsKey | null =
    allowed.createBackups === false ? "refusedCreateBackup" : null;
  const busy: OperatorsKey | null = cluster.switchingOver
    ? "notDuringSwitchover"
    : null;

  if (cluster.hibernated) {
    return [
      {
        id: "wake",
        label: "actionWake",
        explains: "actionWakeExplained",
        reason: noPatch,
        danger: false,
      },
    ];
  }

  const list: PgAction[] = [
    {
      id: "restart",
      label: "actionRestart",
      explains: "actionRestartExplained",
      reason: noPatch ?? busy,
      danger: true,
    },
    {
      id: "reload",
      label: "actionReload",
      explains: "actionReloadExplained",
      reason: noPatch,
      danger: false,
    },
    {
      id: "backup",
      label: "actionBackup",
      explains: "actionBackupExplained",
      reason: noCreate,
      danger: false,
    },
  ];
  for (const instance of cluster.instances) {
    list.push(
      instance.fenced
        ? {
            id: "unfence",
            label: "actionUnfence",
            explains: "actionUnfenceExplained",
            reason: noPatch,
            danger: false,
            instance: instance.name,
          }
        : {
            id: "fence",
            label: "actionFence",
            explains: "actionFenceExplained",
            reason: noPatch ?? busy,
            danger: true,
            instance: instance.name,
          }
    );
  }
  list.push({
    id: "hibernate",
    label: "actionHibernate",
    explains: "actionHibernateExplained",
    reason: noPatch ?? busy,
    danger: true,
  });
  return list;
}

function annotate(
  cluster: PgCluster,
  annotations: Record<string, string | null>
) {
  return commands.patchCustomResource(
    CLUSTERS_CRD,
    cluster.name,
    cluster.namespace,
    {
      metadata: { annotations },
    }
  );
}

/** Perform one action. The patch is a merge patch on the annotation CNPG watches. */
export async function perform(
  action: PgAction,
  cluster: PgCluster,
  now: Date = new Date()
): Promise<void> {
  const stamp = now.toISOString();
  switch (action.id) {
    case "restart":
      return annotate(cluster, { [RESTARTED_AT]: stamp });
    case "reload":
      return annotate(cluster, { [RELOADED_AT]: stamp });
    case "hibernate":
      return annotate(cluster, { [HIBERNATION]: "on" });
    case "wake":
      return annotate(cluster, { [HIBERNATION]: "off" });
    case "fence": {
      const names = [
        ...new Set([...cluster.fenced, action.instance ?? ""]),
      ].filter(Boolean);
      return annotate(cluster, { [FENCED]: JSON.stringify(names) });
    }
    case "unfence": {
      const names = cluster.fenced.filter((n) => n !== action.instance);
      // An empty list is a lie CNPG rejects; the annotation goes away instead.
      return annotate(cluster, {
        [FENCED]: names.length === 0 ? null : JSON.stringify(names),
      });
    }
    case "backup": {
      const name = `${cluster.name}-${stamp.replace(/[-:]/g, "").slice(0, 15).toLowerCase()}`;
      const manifest = [
        "apiVersion: postgresql.cnpg.io/v1",
        "kind: Backup",
        "metadata:",
        `  name: ${name}`,
        `  namespace: ${cluster.namespace}`,
        "spec:",
        "  cluster:",
        `    name: ${cluster.name}`,
      ].join("\n");
      const result = await commands.applyManifest(manifest, cluster.namespace);
      if (!result.success) {
        throw new Error(result.stderr || "Backup was not created");
      }
      return;
    }
  }
}

/** The Backup objects' CRD, for the page's link into the generic list. */
export const BACKUPS_LIST_CRD = BACKUPS_CRD;
