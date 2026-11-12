import { commands } from "@/lib/commands";
import { ERROR_CODES } from "@/lib/error-utils";
import type { en } from "@/i18n/catalogue";
import type { T } from "@/i18n/useT";
import { CLUSTERS_CRD } from "./data";
import {
  FENCED,
  HIBERNATION,
  RELOADED_AT,
  RESTARTED_AT,
  type BackupMethod,
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
  /** For backup: the method the Backup is created with. */
  method?: BackupMethod;
}

/** A method as CNPG spells it, with the plugin where it is one. */
export const methodName = ({ method, plugin }: BackupMethod): string =>
  plugin ? `${method} ${plugin}` : method;

/** The button's words; a backup names its method where the cluster has several. */
export function labelOf(action: PgAction, several: boolean, t: T): string {
  const label = t("operators", action.label);
  if (action.instance) return `${label} ${action.instance}`;
  return action.method && several
    ? `${label} (${methodName(action.method)})`
    : label;
}

/** What the confirmation says will happen; a backup says which method it sends. */
export const explain = (action: PgAction, t: T): string =>
  action.method
    ? t("operators", "actionBackupExplained", {
        method: methodName(action.method),
      })
    : t("operators", action.explains);

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
    // One per method the spec configures: which one a reader means is
    // theirs to say, and with none configured a Backup could only fail.
    ...(cluster.backupMethods.length > 0
      ? cluster.backupMethods
      : [undefined]
    ).map((method): PgAction => ({
      id: "backup",
      label: "actionBackup",
      explains: "actionBackupExplained",
      reason: noCreate ?? (method ? null : "noBackupMethod"),
      danger: false,
      method,
    })),
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

const NO_METHOD = "no backup method was chosen, so none may be sent";

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
      // Left out, CNPG fills in `barmanObjectStore` whatever the cluster has.
      if (!action.method) throw new Error(NO_METHOD);
      const { method, plugin } = action.method;
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
        `  method: ${method}`,
        // Quoted: the name is whatever the cluster's spec holds.
        ...(plugin
          ? ["  pluginConfiguration:", `    name: ${JSON.stringify(plugin)}`]
          : []),
      ].join("\n");
      const applied = await commands.applyManifest(manifest, cluster.namespace);
      const outcome = applied.documents[0]?.outcome;
      if (outcome?.says !== "applied") {
        // The cluster's own words when it has any; otherwise the caller
        // says it in the reader's language — a literal here is invisible to
        // every scanner in this project.
        const words =
          (outcome && "said" in outcome && outcome.said) || BACKUP_REFUSED;
        // Nobody answering keeps its code: the Backup may have been created.
        throw Object.assign(
          new Error(words),
          outcome?.says === "unanswered" && { code: ERROR_CODES.NO_ANSWER }
        );
      }
      return;
    }
  }
}
