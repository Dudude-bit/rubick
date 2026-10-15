import { describe, expect, it } from "vite-plus/test";

import type { PodCause, PodRow } from "@/generated/types";
import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import { scheduledRun } from "@/lib/cron-outcome";
import { rowCause, rowCauseText, rowPods, type RowCause } from "./row-cause";

const t: T = (section, key, values) => translate("en", section, key, values);

const exits: PodCause = {
  says: "exits",
  container: "app",
  restarts: 7,
  run: null,
  until: null,
};

function pod(
  name: string,
  workload: string,
  over: Partial<PodRow["status"]> = {}
): PodRow {
  return {
    name,
    namespace: "shop",
    workload: { kind: "Deployment", name: workload },
    status: {
      phase: "Running",
      display: "CrashLoopBackOff",
      cause: exits,
      ...over,
    },
    containers: [
      {
        name: "app",
        ready: false,
        started: false,
        phase: "app",
        state: {
          type: "waiting",
          reason: "CrashLoopBackOff",
          message: null,
        },
      },
    ],
    initContainers: [],
  } as unknown as PodRow;
}

const healthy = (name: string, workload: string) =>
  ({
    ...pod(name, workload),
    status: { phase: "Running", display: "Running" },
    containers: [
      {
        name: "app",
        ready: true,
        started: true,
        phase: "app",
        state: { type: "running" },
      },
    ],
  }) as unknown as PodRow;

const NOW = Date.now();
const web = { kind: "Deployment", name: "web" };

describe("the cause a workload list's row tells", () => {
  /**
   * A list matched pods to rows by name prefix for its CPU column, which
   * gives `web` the pods of `web-api` too. Fails if a row borrows the cause
   * of a workload whose name merely starts with its own.
   */
  it("reads only the pods Rust put under the row's own workload", () => {
    const pods = rowPods(
      [pod("web-api-5d4c-x9", "web-api"), healthy("web-7f9b-a1", "web")],
      []
    );
    expect(rowCause("shop", web, pods, NOW)).toEqual({
      says: "read",
      shared: null,
    });
    expect(
      rowCause("shop", { kind: "Deployment", name: "web-api" }, pods, NOW)
    ).toMatchObject({ says: "read", shared: { pods: 1, of: 1 } });
  });

  /**
   * Live, a Deployment of one replica read "1 of 26 pods" beside the pods
   * its ReplicaSet had replaced. Fails if a pod the row's status says is gone
   * counts in the whole.
   */
  it("leaves the pods its controller replaced out of the whole", () => {
    const pods = rowPods(
      [
        pod("web-1", "web"),
        pod("web-2", "web", {
          phase: "Failed",
          display: "Evicted",
          gone: "replaced",
        }),
      ],
      []
    );
    expect(rowCause("shop", web, pods, NOW)).toMatchObject({
      shared: { pods: 1, of: 1 },
    });
  });

  /**
   * Live, bad-command's row went quiet for the seconds its pod read
   * StartError between two crashes. Fails if the word the runtime writes
   * on a container it could not start drops the cause.
   */
  it("keeps the cause while a pod reads the runtime's word between crashes", () => {
    const pods = rowPods([pod("web-1", "web", { display: "StartError" })], []);
    expect(rowCause("shop", web, pods, NOW)).toMatchObject({
      shared: { pods: 1, of: 1, cause: exits },
    });
  });

  /**
   * A namespace whose pods were refused looks, row by row, exactly like one
   * whose pods are fine. Fails if a row in it says nothing rather than that
   * it could not look, or says so while the pods are still on their way.
   */
  it("says the pods were not read, or are still being read, rather than that nothing is wrong", () => {
    const pods = rowPods(
      [pod("web-1", "web")],
      [{ namespace: "shop", code: "FORBIDDEN", message: "forbidden" }]
    );
    const unread = rowCause("shop", web, pods, NOW);
    expect(unread).toEqual({ says: "unread" });
    expect(rowCauseText(unread, "trouble", t)).toBe(
      "pods not read, so why is not known"
    );
    const reading = rowCause("shop", web, null, NOW);
    expect(reading).toEqual({ says: "reading" });
    expect(rowCauseText(reading, "trouble", t)).toBe("reading its pods");
  });

  /**
   * A settled row has no cause to lead with, and an open one only the one
   * its pods tell: "pods not read" beside every Running row is noise its
   * badge already carries where it matters.
   */
  it("leaves a settled row quiet, and says what was not read only where the row is trouble", () => {
    const told: RowCause = rowCause(
      "shop",
      web,
      rowPods([pod("web-1", "web")], []),
      NOW
    );
    expect(rowCauseText(told, "settled", t)).toBeNull();
    expect(rowCauseText(told, "open", t)).toMatch(/^1 of 1 pod: app/);
    expect(rowCauseText({ says: "unread" }, "open", t)).toBeNull();
  });
});

describe("scheduledRun", () => {
  /**
   * The CronJob controller names a run after the minute it was scheduled
   * for; live, reports' run at 2026-10-15 05:28 UTC was reports-29867368.
   * Fails if the list reads the cause of any other run.
   */
  it("names the Job a CronJob's last schedule started", () => {
    expect(
      scheduledRun({ name: "reports", lastSchedule: "2026-10-15T05:28:00Z" })
    ).toBe("reports-29867368");
    expect(scheduledRun({ name: "reports", lastSchedule: null })).toBeNull();
  });
});
