import { describe, expect, it } from "vitest";

import { describeCron, nextCronRun, parseCron } from "./cron-schedule";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";

/** The English catalogue — what these expectations are written in. */
const t: T = (section, key, values) => translate("en", section, key, values);

/** Fixed point of reference: a Wednesday, 14:37 UTC. */
const NOW = new Date("2026-03-11T14:37:00Z");

/** The walk runs on wall-clock fields, so pin every case to a named zone. */
function next(schedule: string, from = NOW) {
  return nextCronRun(schedule, from, "UTC")?.toISOString() ?? null;
}

describe("parseCron", () => {
  it("rejects anything that is not five fields", () => {
    expect(parseCron("0 0 * *")).toBeNull();
    expect(parseCron("0 0 * * * *")).toBeNull();
    expect(parseCron("")).toBeNull();
  });

  it("rejects out-of-range and malformed fields", () => {
    expect(parseCron("60 * * * *")).toBeNull();
    expect(parseCron("* 24 * * *")).toBeNull();
    expect(parseCron("* * 0 * *")).toBeNull();
    expect(parseCron("*/0 * * * *")).toBeNull();
    expect(parseCron("banana * * * *")).toBeNull();
  });

  it("expands steps, ranges and lists", () => {
    expect([...parseCron("*/15 * * * *")!.minutes]).toEqual([0, 15, 30, 45]);
    expect([...parseCron("0 9-11 * * *")!.hours]).toEqual([9, 10, 11]);
    expect([...parseCron("0 0 1,15 * *")!.daysOfMonth]).toEqual([1, 15]);
  });

  it("reads month and weekday names", () => {
    expect([...parseCron("0 0 1 JAN *")!.months]).toEqual([1]);
    expect([...parseCron("0 0 * * MON")!.daysOfWeek]).toEqual([1]);
  });

  it("treats both 0 and 7 as Sunday", () => {
    expect(parseCron("0 0 * * 7")!.daysOfWeek.has(0)).toBe(true);
  });

  it("expands the macros Kubernetes accepts", () => {
    expect(parseCron("@daily")!.raw).toEqual(["0", "0", "*", "*", "*"]);
    expect(parseCron("@hourly")!.raw).toEqual(["0", "*", "*", "*", "*"]);
  });
});

describe("nextCronRun", () => {
  it("finds the next minute of a step schedule", () => {
    expect(next("*/15 * * * *")).toBe("2026-03-11T14:45:00.000Z");
  });

  it("rolls into the next day when today's slot has passed", () => {
    expect(next("0 3 * * *")).toBe("2026-03-12T03:00:00.000Z");
  });

  it("keeps today's slot when it is still ahead", () => {
    expect(next("0 23 * * *")).toBe("2026-03-11T23:00:00.000Z");
  });

  it("honours the weekday field", () => {
    // NOW is a Wednesday; the next Monday is the 16th.
    expect(next("30 6 * * MON")).toBe("2026-03-16T06:30:00.000Z");
  });

  it("honours the day-of-month field across a month boundary", () => {
    expect(next("0 0 1 * *")).toBe("2026-04-01T00:00:00.000Z");
  });

  it("takes the union when both day fields are restricted", () => {
    // The 13th is a Friday here, but Thursday the 12th matches the weekday.
    expect(next("0 0 13 * THU")).toBe("2026-03-12T00:00:00.000Z");
  });

  it("crosses the year boundary", () => {
    expect(next("0 0 1 JAN *")).toBe("2027-01-01T00:00:00.000Z");
  });

  it("resolves the wall clock in the schedule's own zone", () => {
    // 09:00 in Tokyo is 00:00 UTC, i.e. the next calendar day there.
    expect(nextCronRun("0 9 * * *", NOW, "Asia/Tokyo")?.toISOString()).toBe(
      "2026-03-12T00:00:00.000Z"
    );
  });

  it("falls back to the local zone for an unusable zone name", () => {
    expect(nextCronRun("*/15 * * * *", NOW, "Not/AZone")).toBeInstanceOf(Date);
  });

  it("returns null for an unparsable schedule", () => {
    expect(next("not a schedule")).toBeNull();
  });
});

describe("describeCron", () => {
  it.each([
    ["* * * * *", "every minute"],
    ["*/5 * * * *", "every 5 minutes"],
    ["17 * * * *", "hourly at :17"],
    ["0 */6 * * *", "every 6 hours, at :00"],
    ["30 3 * * *", "daily at 03:30"],
    ["0 9 * * MON", "every Monday at 09:00"],
    ["0 9 * * 1-5", "weekdays at 09:00"],
    ["0 0 1 * *", "monthly on day 1 at 00:00"],
    ["@daily", "daily at 00:00"],
  ])("reads %s as %s", (schedule, expected) => {
    expect(describeCron(schedule, t)).toBe(expected);
  });

  it("says nothing rather than guessing at an unusual shape", () => {
    expect(describeCron("0 0 1,15 */2 3", t)).toBeNull();
    expect(describeCron("nonsense", t)).toBeNull();
  });
});
