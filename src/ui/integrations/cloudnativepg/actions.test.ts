import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const applyManifest = vi.fn();
vi.mock("@/lib/commands", () => ({
  commands: { applyManifest: (...args: unknown[]) => applyManifest(...args) },
}));

import { BACKUP_REFUSED, perform, type PgAction } from "./actions";
import type { PgCluster } from "./model";
import { isUnanswered } from "@/lib/error-utils";

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
