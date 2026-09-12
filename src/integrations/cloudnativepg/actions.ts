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
  // A failover is the same reason to hold as a switchover, and a stronger
  // one: the operator is mid-promotion and nobody asked it to be.
  const busy: OperatorsKey | null =
    cluster.switchingOver || cluster.failingOver ? "notDuringSwitchover" : null;
  // Fencing is written back as a whole list, so acting on a list we did not
  // read would overwrite it — and unfence every instance it really named.
  const blind: OperatorsKey | null = cluster.fencedKnown
    ? null
    : "fencingUnknown";

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
      // `null` is "we could not read whether this one is fenced". Offering
      // Unfence would be a guess; the control offered is Fence, and it says
      // why it cannot run.
      instance.fenced === true
        ? {
            id: "unfence",
            label: "actionUnfence",
            explains: "actionUnfenceExplained",
            // Under a `*` there is no list to take one name out of; taking
            // the names we know and writing them back would unfence every
            // instance CNPG has not named yet.
            reason:
              noPatch ?? blind ?? (cluster.fencedAll ? "fencedAllOne" : null),
            danger: false,
            instance: instance.name,
          }
        : {
            id: "fence",
            label: "actionFence",
            explains: "actionFenceExplained",
            reason: noPatch ?? busy ?? blind,
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

/**
 * The last guard before a write, for the one list this page rewrites whole.
 * `actionsFor` already refuses these two, so reaching here means a caller
 * went round it — and a fence written from a list we did not read unfences
 * whatever it really held.
 */
const WOULD_OVERWRITE =
  "the fenced-instances annotation was not read, so it must not be rewritten";

/** Matched by the caller, which turns it into a catalogue sentence. */
export const BACKUP_REFUSED = "cnpg:backup-not-created";

const WOULD_NARROW =
  "the whole cluster is fenced with `*`; one instance cannot be taken out of it";

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
      if (!cluster.fencedKnown) throw new Error(WOULD_OVERWRITE);
      const names = [
        ...new Set([...cluster.fenced, action.instance ?? ""]),
      ].filter(Boolean);
      return annotate(cluster, { [FENCED]: JSON.stringify(names) });
    }
    case "unfence": {
      if (!cluster.fencedKnown) throw new Error(WOULD_OVERWRITE);
      if (cluster.fencedAll) throw new Error(WOULD_NARROW);
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
        // The cluster's own words when it has any; otherwise the caller
        // says it in the reader's language — a literal here is invisible to
        // every scanner in this project.
        throw new Error(result.stderr || BACKUP_REFUSED);
      }
      return;
    }
  }
}

/** The Backup objects' CRD, for the page's link into the generic list. */
export const BACKUPS_LIST_CRD = BACKUPS_CRD;
