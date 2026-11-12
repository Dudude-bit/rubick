import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const applyManifest = vi.fn();
vi.mock("@/lib/commands", () => ({
  commands: { applyManifest: (...args: unknown[]) => applyManifest(...args) },
}));

import {
  BACKUP_REFUSED,
  actionsFor,
  explain,
  labelOf,
  perform,
  type PgAction,
} from "./actions";
import type { BackupMethod, PgCluster } from "./model";
import { isUnanswered } from "@/lib/error-utils";
import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";

const t: T = (section, key, values) => translate("en", section, key, values);
const OBJECT_STORE: BackupMethod = { method: "barmanObjectStore" };
const SNAPSHOT: BackupMethod = { method: "volumeSnapshot" };
const PLUGIN: BackupMethod = {
  method: "plugin",
  plugin: "barman-cloud.cloudnative-pg.io",
};
const backup = { id: "backup", method: OBJECT_STORE } as PgAction;
const cluster = { name: "pg", namespace: "shop" } as PgCluster;
const clusterWith = (...backupMethods: BackupMethod[]) =>
  ({
    name: "pg",
    namespace: "shop",
    instances: [],
    fencedKnown: true,
    backupMethods,
  }) as unknown as PgCluster;
const ALLOWED = { patchClusters: true, createBackups: true };
const backupsOffered = (cluster: PgCluster, allowed = ALLOWED) =>
  actionsFor(cluster, allowed).filter((action) => action.id === "backup");
const answered = (outcome: unknown) => ({
  documents: [{ id: "backup/shop pg", outcome }],
});

describe("taking a backup", () => {
  beforeEach(() => applyManifest.mockReset());

  /**
   * The Backup object is created through the manifest apply, which answers
   * per document and resolves even when the cluster said no. Fails if a
   * Backup that was refused, or that nobody answered for, reads as taken.
   */
  it("is done only when the cluster stored the Backup", async () => {
    applyManifest.mockResolvedValue(answered({ says: "applied" }));
    await expect(perform(backup, cluster)).resolves.toBeUndefined();

    applyManifest.mockResolvedValue(
      answered({ says: "refused", code: "PERMISSION_DENIED", said: "no" })
    );
    await expect(perform(backup, cluster)).rejects.toThrow("no");

    applyManifest.mockResolvedValue(
      answered({ says: "unanswered", said: "did not answer within 60 s" })
    );
    await expect(perform(backup, cluster)).rejects.toThrow(
      "did not answer within 60 s"
    );
  });

  /**
   * The page calls a thrown action failed unless the error says nobody
   * answered. Fails if a Backup the cluster may have created reads as a
   * failed one, or a refused one as unanswered.
   */
  it("tells a Backup nobody answered for from one the cluster refused", async () => {
    const thrownFor = (outcome: unknown) => {
      applyManifest.mockResolvedValue(answered(outcome));
      return perform(backup, cluster).catch((error: unknown) => error);
    };
    expect(
      isUnanswered(await thrownFor({ says: "unanswered", said: "502" }))
    ).toBe(true);
    expect(
      isUnanswered(
        await thrownFor({ says: "refused", code: "NOT_FOUND", said: "no" })
      )
    ).toBe(false);
  });

  /** With no words from the cluster the caller says it in the reader's language. */
  it("leaves the sentence to the caller when the cluster gave none", async () => {
    applyManifest.mockResolvedValue({ documents: [] });
    await expect(perform(backup, cluster)).rejects.toThrow(BACKUP_REFUSED);
  });
});

describe("the method a Backup is created with", () => {
  beforeEach(() =>
    applyManifest.mockReset().mockResolvedValue(answered({ says: "applied" }))
  );
  const sent = () => applyManifest.mock.calls[0][0] as string;

  /**
   * A Backup with no `spec.method` runs as barmanObjectStore, and fails on a
   * cluster that backs up through a plugin or volume snapshots only. Fails
   * if the manifest leaves the method out or sends another than was picked.
   */
  it("is written into the manifest, with the plugin's name where it is one", async () => {
    await perform({ ...backup, method: SNAPSHOT }, cluster);
    expect(sent()).toContain("\n  method: volumeSnapshot");
    expect(sent()).not.toContain("pluginConfiguration");

    applyManifest.mockClear();
    await perform({ ...backup, method: PLUGIN }, cluster);
    expect(sent()).toContain(
      '\n  method: plugin\n  pluginConfiguration:\n    name: "barman-cloud.cloudnative-pg.io"'
    );
  });

  /** Fails if a Backup is created with no method, leaving CNPG's default to pick one. */
  it("is never left for the operator to default", async () => {
    await expect(
      perform({ id: "backup" } as PgAction, cluster)
    ).rejects.toThrow(/no backup method/);
    expect(applyManifest).not.toHaveBeenCalled();
  });

  /**
   * The spec may configure an object store and snapshots at once, and only
   * the reader knows which they mean. Fails if one is picked for them, or
   * the two buttons cannot be told apart.
   */
  it("is one button per method the cluster's spec configures", () => {
    const offered = backupsOffered(clusterWith(OBJECT_STORE, SNAPSHOT));

    expect(offered.map((action) => action.method)).toEqual([
      OBJECT_STORE,
      SNAPSHOT,
    ]);
    expect(offered.map((action) => labelOf(action, true, t))).toEqual([
      "Backup now (barmanObjectStore)",
      "Backup now (volumeSnapshot)",
    ]);
    expect(labelOf(offered[0], false, t)).toBe("Backup now");
  });

  /**
   * With nothing configured a Backup can only fail. Fails if the button
   * creates one anyway, or hides the refusal that outranks it.
   */
  it("is not offered where the spec configures no backup, and says why", () => {
    const [none] = backupsOffered(clusterWith());
    expect(none.reason).toBe("noBackupMethod");
    expect(none.method).toBeUndefined();

    const [refused] = backupsOffered(clusterWith(), {
      ...ALLOWED,
      createBackups: false,
    });
    expect(refused.reason).toBe("refusedCreateBackup");
    expect(backupsOffered(clusterWith(SNAPSHOT))[0].reason).toBeNull();
  });

  /** Fails if the confirmation does not name the method the click will send. */
  it("is named in the confirmation before the click", () => {
    expect(explain({ ...backup, method: PLUGIN }, t)).toContain(
      "with method plugin barman-cloud.cloudnative-pg.io,"
    );
    expect(explain({ ...backup, method: SNAPSHOT }, t)).not.toContain("{");
    expect(
      explain(
        { id: "reload", explains: "actionReloadExplained" } as PgAction,
        t
      )
    ).toBe(translate("en", "operators", "actionReloadExplained"));
  });
});
