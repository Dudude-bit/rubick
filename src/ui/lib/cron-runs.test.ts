import { describe, expect, it } from "vite-plus/test";

import { isPodOfRun } from "./cron-runs";

const pod = (kind: string, name: string) => ({ workload: { kind, name } });

describe("isPodOfRun", () => {
  /**
   * The CronJob page took every pod whose name began with the CronJob's:
   * `backup` showed the pods, usage and logs of Deployment `backup-web`.
   * Fails if a pod's own name decides, or a run named by hand is lost.
   */
  it("takes the pods of the CronJob's runs and nothing that is only named alike", () => {
    expect(isPodOfRun("backup", pod("Job", "backup-28901234"))).toBe(true);
    expect(isPodOfRun("backup", pod("Job", "backup-before-migration"))).toBe(
      true
    );
    expect(isPodOfRun("backup", pod("Deployment", "backup-web"))).toBe(false);
    expect(isPodOfRun("backup", pod("Job", "backups-1"))).toBe(false);
    expect(isPodOfRun("backup", { workload: null })).toBe(false);
  });
});
