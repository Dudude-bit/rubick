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
  lastRunOut,
  rolloutLine,
  rolloutStatusOf,
  withStarts,
  workloadStatus,
  workloadWord as rolloutWord,
} from "./workload-status";

const t = ((section: string, key: string) => `${section}.${key}`) as T;

const EVERY: Rollout[] = [
  { state: "idle" },
  { state: "stalled", message: "timed out", serving: 2 },
  { state: "unavailable", reason: "MinimumReplicasUnavailable", message: null },
  { state: "paused" },
  { state: "unobserved" },
  { state: "rollingOut", updated: 1, desired: 3 },
  { state: "comingUp", available: 1, desired: 2 },
  { state: "short", available: 2, desired: 3 },
  { state: "ready" },
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
  cases: { name: string; rollout: Rollout; pods: PodStart[]; is: Rollout }[];
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
      const deadlines = pods.flatMap((pod) =>
        pod.state === "starting" ? [Date.parse(pod.until)] : []
      );
      expect(
        withStarts(rollout, pods, lastRunOut(deadlines, now)),
        name
      ).toEqual(withStarts(rollout, pods, now));
    }
  });
});
