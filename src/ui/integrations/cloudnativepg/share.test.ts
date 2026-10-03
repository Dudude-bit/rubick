import { describe, expect, it } from "vitest";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import { backupsSection } from "./share";

const t: T = (section, key, values) => translate("en", section, key, values);

const read = { ok: true as const, items: [] };

describe("what the CloudNativePG screen tells Share about backups", () => {
  /** A refused Backup list returned no section: "no backup failed". */
  it("marks the backups unread when their list was refused", () => {
    const section = backupsSection(
      {
        backups: { ok: false, reason: "backups is forbidden" },
        scheduled: read,
        poolers: read,
      },
      t
    );
    expect(section?.unread).toBe("backups is forbidden");
  });

  it("marks the backups unread while they are still being read", () => {
    expect(backupsSection(undefined, t)?.unread).toBe(
      "Still being read when the report was made."
    );
  });

  it("reports nothing when the backups were read and none failed", () => {
    expect(
      backupsSection({ backups: read, scheduled: read, poolers: read }, t)
    ).toBeNull();
  });
});
