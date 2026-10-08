import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vite-plus/test";

import type { PodStart, Rollout } from "@/generated/types";
import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import { statusRole } from "./status-role";
import {
  NEEDS_ATTENTION,
  ROLLOUT_CODES,
  attentionOf,
  lastRunOut,
  rolloutLine,
  rolloutStatusOf,
  rolloutVerdict,
  rowsWithStarts,
  startsOf,
  withStarts,
  workloadRole,
  workloadStatus,
  workloadWord as rolloutWord,
} from "./workload-status";

const t = ((section: string, key: string) => `${section}.${key}`) as T;

const EVERY: Rollout[] = [
  { state: "idle" },
  { state: "stalled", message: "timed out", serving: 2 },
  {
    state: "unavailable",
    reason: "MinimumReplicasUnavailable",
    message: null,
    available: 0,
    desired: 2,
  },
  { state: "paused" },
  { state: "unobserved", available: 1, desired: 2 },
  { state: "rollingOut", updated: 1, desired: 3 },
  { state: "comingUp", available: 1, desired: 2 },
  { state: "short", available: 2, desired: 3 },
  { state: "ready" },
  { state: "scalingDown", current: 2, desired: 1 },
];

describe("the word a workload's rollout comes to", () => {
  const shared = JSON.parse(
    readFileSync(
      resolve(process.cwd(), "src/contracts/rollout-codes.json"),
      "utf8"
    )
  ) as { codes: Record<string, string>; needsAttention: string[] };

  /** The overview prints the backend's word for the same Deployment the list draws with this one. */
  it("prints the word the shared file states for every state", () => {
    expect(ROLLOUT_CODES).toEqual(shared.codes);
    expect([...NEEDS_ATTENTION].sort()).toEqual(
      [...shared.needsAttention].sort()
    );
  });

  /**
   * The `search` and `payments` cases: a rollout past its deadline, and one
   * with no pod available, both read as calm blue Progressing or green Ready
   * when the word came from replica counts.
   */
  it("colours a stalled rollout and an unavailable one as faults", () => {
    expect(statusRole(workloadStatus(EVERY[1]))).toBe("err");
    expect(statusRole(workloadStatus(EVERY[2]))).toBe("err");
  });

  /** A word statusRole does not know turns the badge grey with nothing failing. */
  it("only ever says something statusRole has a colour for", () => {
    const roles = EVERY.map((rollout) => statusRole(workloadStatus(rollout)));
    expect(roles).toEqual([
      "neutral",
      "err",
      "err",
      "warn",
      "pending",
      "pending",
      "pending",
      "warn",
      "ok",
      "pending",
    ]);
  });

  /**
   * Lena's scale from 1 to 2 drew a red "Unavailable" while a pod served.
   * Fails if pods coming up wear a fault's colour or go without a sentence.
   */
  it("draws pods coming up as progress, with a sentence, never as a fault", () => {
    const comingUp: Rollout = { state: "comingUp", available: 1, desired: 2 };
    expect(workloadStatus(comingUp)).toBe("Progressing");
    expect(statusRole(workloadStatus(comingUp))).toBe("pending");
    expect(NEEDS_ATTENTION.has("comingUp")).toBe(false);
    expect(rolloutLine(comingUp, t)).toEqual({
      tone: "info",
      text: "readings.rolloutComingUp",
      said: null,
    });
  });

  /** orders-db scaled 2 to 1 read green Ready at 2/1. Fails if a set with
   *  pods still to remove reads settled, or wears a fault's colour. */
  it("draws a scale-down still under way as progress with its counts", () => {
    const down: Rollout = { state: "scalingDown", current: 2, desired: 1 };
    expect(workloadStatus(down)).toBe("Progressing");
    expect(NEEDS_ATTENTION.has("scalingDown")).toBe(false);
    const en: T = (section, key, values) =>
      translate("en", section, key, values);
    expect(rolloutLine(down, en)).toEqual({
      tone: "info",
      text: "Scaling down: 2 pods still exist, 1 is wanted",
      said: null,
    });
  });

  /** Ready and Idle are the whole story; every other state owes a sentence. */
  it("has a sentence for every state but the settled two", () => {
    for (const rollout of EVERY) {
      const settled = rollout.state === "ready" || rollout.state === "idle";
      expect(rolloutLine(rollout, t) === null).toBe(settled);
    }
    expect(rolloutLine(EVERY[1], t)?.said).toBe("timed out");
  });

  /** The shared report says the badge's word beside the count, and only when it is not ready. */
  it("puts the word beside the count only when the rollout is not settled", () => {
    expect(rolloutStatusOf(2, 2, { state: "ready" }, t)).toEqual({
      text: "count.slashReady",
      role: "ok",
    });
    expect(rolloutStatusOf(2, 2, EVERY[1], t)).toEqual({
      text: "statusWords.stalled · count.slashReady",
      role: "err",
    });
  });

  /**
   * Lena's shared Deployment report said "Stalled" in English among Russian
   * words. Fails if the report goes back to the code, or if the colour moves
   * with the word: the role is still read from the English code.
   */
  it("words the report's verdict in the reader's language and keeps its colour", () => {
    const ru: T = (section, key, values) =>
      translate("ru", section, key, values);
    expect(rolloutStatusOf(0, 2, EVERY[1], ru)).toEqual({
      text: "Застрял · 0/2 готовы",
      role: "err",
    });
    expect(rolloutWord({ state: "short", available: 2, desired: 3 }, ru)).toBe(
      "Деградировал"
    );
    expect(rolloutWord(EVERY[0], ru)).toBe("Простаивает");
    expect(rolloutWord(EVERY[2], ru)).toBe("Unavailable");
  });
});

const setCorpus = JSON.parse(
  readFileSync(
    resolve(process.cwd(), "src/contracts/set-rollout-conformance.json"),
    "utf8"
  )
) as {
  now: string;
  cases: {
    name: string;
    rollout: Rollout;
    pods: PodStart[] | null;
    is: Rollout;
  }[];
};

describe("a set's verdict with its pods asked", () => {
  /**
   * The list reads a set's pods here and its page, peek and Needs attention
   * read them in Rust. Fails if this side answers any case of the shared
   * corpus differently, which would put two words on one scale.
   */
  it("answers every case in the shared corpus as the backend does", () => {
    const now = Date.parse(setCorpus.now);
    for (const { name, rollout, pods, is } of setCorpus.cases)
      expect(withStarts(rollout, pods, now), name).toEqual(is);
  });

  /**
   * The list wakes on the latest start to run out instead of on every tick.
   * Fails if that instant answers any case differently from the clock itself.
   */
  it("answers the same at the latest start to run out as at the clock it stands for", () => {
    const now = Date.parse(setCorpus.now);
    for (const { name, rollout, pods } of setCorpus.cases) {
      const deadlines = (pods ?? []).flatMap((pod) =>
        pod.state === "starting" ? [Date.parse(pod.until)] : []
      );
      expect(
        withStarts(rollout, pods, lastRunOut(deadlines, now)),
        name
      ).toEqual(withStarts(rollout, pods, now));
    }
  });
});

describe("a verdict whose pods were not read", () => {
  const counted: Rollout = {
    state: "unavailable",
    reason: "MinimumReplicasUnavailable",
    message: "Deployment does not have minimum availability.",
    available: 0,
    desired: 1,
  };
  const unread = withStarts(counted, null, 0);

  /**
   * A refused or unloaded pod list left the controller's Unavailable red
   * while the page said coming up. Fails if a verdict nobody checked against
   * its pods wears a fault's colour, loses the controller's word, or is
   * counted among what needs attention.
   */
  it("keeps the controller's word in a neutral colour, and is no fault", () => {
    expect(unread).toEqual({ state: "podsUnread", controller: counted });
    expect(workloadStatus(unread)).toBe("Unavailable");
    expect(workloadRole(unread)).toBe("neutral");
    expect(workloadRole(counted)).toBe("err");
    expect(NEEDS_ATTENTION.has(unread.state)).toBe(false);
  });

  /** Fails if the sentence stops saying the pods were not read, or drops the controller's own message. */
  it("says the pods were not read, with the controller's message after it", () => {
    const en: T = (section, key, values) =>
      translate("en", section, key, values);
    expect(rolloutLine(unread, en)).toEqual({
      tone: "unknown",
      text: "Unavailable by the controller's counts alone: its pods could not be read, so whether they are still starting is not known",
      said: "Deployment does not have minimum availability.",
    });
  });

  /** A shared report and a list's share read the colour too. Fails if either paints the unchecked verdict red or drops the mark. */
  it("is shared neutral, marked as unchecked", () => {
    expect(rolloutVerdict(unread, t)).toEqual({
      text: "Unavailable · readings.rolloutPodsUnreadShort",
      role: "neutral",
    });
    expect(rolloutStatusOf(0, 1, unread, t)).toEqual({
      text: "Unavailable · readings.rolloutPodsUnreadShort · count.slashReady",
      role: "neutral",
    });
  });

  /**
   * The list asks each row's pods unless they were not read at all, or not
   * in that row's namespace. Fails if an unread namespace's row is judged on
   * the absence of its pods, or a read one is not judged at all.
   */
  it("leaves a row in an unread namespace the controller's alone and asks the rest", () => {
    const short: Rollout = { state: "short", available: 1, desired: 2 };
    const rows = [
      { name: "web", namespace: "shop", rollout: short },
      { name: "web", namespace: "ops", rollout: short },
    ];
    const starts = startsOf(
      [
        {
          namespace: "shop",
          start: { state: "starting", until: "2026-10-08T10:05:00Z" },
          workload: { kind: "StatefulSet", name: "web" },
        },
      ],
      [{ namespace: "ops" }]
    );
    const now = Date.parse("2026-10-08T10:00:00Z");
    expect(
      rowsWithStarts("StatefulSet", rows, starts, now).map((r) => r.rollout)
    ).toEqual([
      { state: "comingUp", available: 1, desired: 2 },
      { state: "podsUnread", controller: short },
    ]);
    expect(
      rowsWithStarts("StatefulSet", rows, null, now).map((r) => r.rollout)
    ).toEqual([
      { state: "podsUnread", controller: short },
      { state: "podsUnread", controller: short },
    ]);
  });

  /** The namespace peek counts what needs attention. Fails if an unchecked verdict is counted as a fault, or not counted at all. */
  it("is counted apart from what needs attention", () => {
    expect(attentionOf([counted, unread, { state: "ready" }])).toEqual({
      attention: 1,
      unconfirmed: 1,
    });
  });
});
