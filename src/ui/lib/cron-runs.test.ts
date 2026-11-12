import { describe, expect, it } from "vite-plus/test";

import { isPodOfRun, isRunOf } from "./cron-runs";

const pod = (kind: string, name: string) => ({ workload: { kind, name } });

describe("isRunOf", () => {
  /**
   * A Job was a CronJob's run when its name began with the CronJob's: the
   * page of `backup` listed the runs of `backup-nightly`, counted them in
   * its history and said their failure as its own last run. Fails if a name
   * decides, or a run named by hand is lost.
   */
  it("takes the Jobs the CronJob controls and nothing that is only named alike", () => {
    expect(isRunOf("backup", { cronJob: "backup" })).toBe(true);
    expect(isRunOf("backup", { cronJob: "backup-nightly" })).toBe(false);
    expect(isRunOf("backup", { cronJob: null })).toBe(false);
  });
});

describe("isPodOfRun", () => {
  /**
   * The CronJob page took every pod whose Job's name began with the
   * CronJob's: `backup` showed the pods, usage and logs of the runs of
   * `backup-nightly`, and before that of Deployment `backup-web`. Fails if
   * a name decides, or a run named by hand is lost.
   */
  it("takes the pods of the CronJob's runs and nothing that is only named alike", () => {
    const runs = [{ name: "backup-28901234" }, { name: "before-migration" }];
    expect(isPodOfRun(runs, pod("Job", "backup-28901234"))).toBe(true);
    expect(isPodOfRun(runs, pod("Job", "before-migration"))).toBe(true);
    expect(isPodOfRun(runs, pod("Job", "backup-nightly-28901234"))).toBe(false);
    expect(isPodOfRun(runs, pod("Deployment", "backup-28901234"))).toBe(false);
    expect(isPodOfRun(runs, { workload: null })).toBe(false);
  });
});
