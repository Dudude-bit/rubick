import { describe, expect, it } from "vite-plus/test";

import { cronBadge, cronOutcome } from "./cron-outcome";
import type { T } from "@/i18n/useT";

const at = (minutesAgo: number) =>
  new Date(
    Date.parse("2026-10-15T05:00:00Z") - minutesAgo * 60_000
  ).toISOString();

describe("how a CronJob's newest run went", () => {
  /**
   * Live, reports had succeeded once and then failed every run for six days,
   * and its page stayed neutral because a success existed at all. Fails if a
   * success older than the last schedule still reads as the last run's.
   */
  it("says a run that ended after the last success did not succeed", () => {
    expect(
      cronOutcome({
        active: 0,
        lastSchedule: at(2),
        lastSuccessfulTime: at(60 * 24 * 6),
      })
    ).toBe("notSucceeded");
    expect(
      cronOutcome({ active: 0, lastSchedule: at(2), lastSuccessfulTime: null })
    ).toBe("notSucceeded");
  });

  /** Fails if a success that came after the last schedule, its own run's, is not read as one. */
  it("says the last run succeeded when the success is its own", () => {
    expect(
      cronOutcome({ active: 0, lastSchedule: at(2), lastSuccessfulTime: at(1) })
    ).toBe("succeeded");
  });

  /** Fails if a run in flight is judged by the success before it. */
  it("says a run in flight is running, not how the one before it ended", () => {
    expect(
      cronOutcome({ active: 1, lastSchedule: at(1), lastSuccessfulTime: at(3) })
    ).toBe("running");
  });

  /**
   * Live, root-cron's run sat in a blue "running" beside the red refusal of
   * its pods. Fails if a refused run in flight still reads as running, or a
   * refusal is laid on a run that has ended.
   */
  it("says a run in flight whose pods are refused has not started", () => {
    const inFlight = {
      active: 1,
      lastSchedule: at(1),
      lastSuccessfulTime: null,
    };
    expect(cronOutcome(inFlight, true)).toBe("refused");
    expect(cronOutcome({ ...inFlight, active: 0 }, true)).toBe("notSucceeded");
  });

  /** Fails if a CronJob that never fired reads as one that failed, or one run only by hand as never run. */
  it("tells never fired from run only by hand", () => {
    expect(
      cronOutcome({ active: 0, lastSchedule: null, lastSuccessfulTime: null })
    ).toBe("never");
    expect(
      cronOutcome({ active: 0, lastSchedule: null, lastSuccessfulTime: at(5) })
    ).toBe("succeeded");
  });
});

describe("cronBadge", () => {
  const t = ((section: string, key: string) => `${section}.${key}`) as T;
  const at = (minute: number) =>
    new Date(Date.UTC(2026, 9, 15, 10, minute)).toISOString();
  const cron = {
    suspend: false,
    active: 0,
    lastSchedule: at(5),
    lastSuccessfulTime: at(6),
  };

  /** Live, a green "Active" headed root-cron while every run was refused; fails if a last run in trouble is badged Active, or suspended loses to it. */
  it("badges a last run in trouble in its own code, and suspended over all", () => {
    expect(cronBadge({ ...cron, active: 1 }, true, t)).toEqual({
      status: "FailedCreate",
      label: "statusWords.lastRunNotStarted",
    });
    expect(cronBadge({ ...cron, lastSuccessfulTime: at(1) }, false, t)).toEqual(
      { status: "Failed", label: "statusWords.lastRunNotSucceeded" }
    );
    expect(cronBadge({ ...cron, active: 1 }, false, t).status).toBe("Active");
    expect(cronBadge(cron, false, t).status).toBe("Active");
    expect(
      cronBadge({ ...cron, suspend: true, active: 1 }, true, t).status
    ).toBe("Suspended");
  });
});
