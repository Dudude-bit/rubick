import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const applyManifest = vi.fn();
vi.mock("@/lib/commands", () => ({
  commands: { applyManifest: (...args: unknown[]) => applyManifest(...args) },
}));

import { BACKUP_REFUSED, perform, type PgAction } from "./actions";
import type { PgCluster } from "./model";

const backup = { id: "backup" } as PgAction;
const cluster = { name: "pg", namespace: "shop" } as PgCluster;
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

  /** With no words from the cluster the caller says it in the reader's language. */
  it("leaves the sentence to the caller when the cluster gave none", async () => {
    applyManifest.mockResolvedValue({ documents: [] });
    await expect(perform(backup, cluster)).rejects.toThrow(BACKUP_REFUSED);
  });
});
