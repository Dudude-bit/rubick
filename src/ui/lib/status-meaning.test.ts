import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { loadLocale, translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import {
  JOB,
  podStatusMeaning,
  statusMeaning,
  workloadStatusMeaning,
} from "./status-meaning";
import { statusRole } from "./status-role";

const t: T = (section, key, values) => translate("en", section, key, values);

describe("what a status means", () => {
  /** The tooltip said "Phase Pending" under a badge that said Pending. */
  it("explains a phase instead of repeating it", () => {
    expect(podStatusMeaning("Pending", "Pending", t)).toBe(
      "Pending: accepted by the cluster, but not every container is running yet; usually waiting for a node or an image."
    );
  });

  it("explains the kubelet's own word for a stuck container", () => {
    expect(podStatusMeaning("CrashLoopBackOff", "Running", t)).toMatch(
      /^CrashLoopBackOff: a container keeps exiting soon after it starts/
    );
  });

  /** An init container's trouble is the same trouble, and says whose it is. */
  it("says when the container in trouble is an init container", () => {
    const meaning = podStatusMeaning("Init:ImagePullBackOff", "Pending", t);
    expect(meaning).toMatch(/^Init:ImagePullBackOff: the node could not pull/);
    expect(meaning).toMatch(/It is an init container/);
    expect(podStatusMeaning("Init:1/3", "Pending", t)).toBe(
      "Init:1/3: init containers run one at a time before the app's own; 1 of 3 have finished."
    );
  });

  it("reads an exit code and a signal kubectl printed for want of a reason", () => {
    expect(podStatusMeaning("ExitCode:137", "Failed", t)).toBe(
      "ExitCode:137: a container exited with code 137 and gave no reason."
    );
    expect(podStatusMeaning("Signal:9", "Failed", t)).toBe(
      "Signal:9: a container was stopped by signal 9."
    );
  });

  /**
   * A reason nobody listed still gets the phase explained, so the badge
   * never goes back to saying nothing; and an object key is not a reason.
   */
  it("falls back to the phase for a word it does not know", () => {
    expect(podStatusMeaning("SomethingNew", "Running", t)).toMatch(
      /^Phase Running: placed on a node/
    );
    expect(podStatusMeaning("toString", null, t)).toBeUndefined();
  });

  it("explains a workload's word, and nothing for one it has no meaning for", () => {
    expect(workloadStatusMeaning("Idle", t)).toBe(
      "Idle: scaled to zero replicas on purpose, so nothing runs."
    );
    expect(workloadStatusMeaning("Bound", t)).toBeUndefined();
  });

  /** The peek draws every kind; Pending on a claim is not a pod's Pending. */
  it("explains only the kinds whose words it knows", () => {
    expect(statusMeaning("Pod", "Running", t)).toMatch(/^Running: /);
    expect(statusMeaning("Deployment", "Ready", t)).toMatch(/^Ready: /);
    expect(
      statusMeaning("PersistentVolumeClaim", "Pending", t)
    ).toBeUndefined();
  });

  it("explains in Russian and keeps the cluster's word", async () => {
    await loadLocale("ru");
    const ru: T = (section, key, values) =>
      translate("ru", section, key, values);
    expect(podStatusMeaning("OOMKilled", "Running", ru)).toBe(
      "OOMKilled: контейнер превысил лимит памяти и был принудительно остановлен."
    );
  });
});

describe("what a Job's word means", () => {
  const shared = JSON.parse(
    readFileSync(resolve(process.cwd(), "src/contracts/job-codes.json"), "utf8")
  ) as { codes: string[] };

  /**
   * The backend prints these words for the list, the page and the peek. A
   * word missing here turns the badge grey and its tooltip blank with
   * nothing failing, which is how Complete went unlisted.
   */
  it("explains and colours every word the backend prints", () => {
    expect(Object.keys(JOB)).toEqual(shared.codes);
    for (const code of shared.codes)
      expect(statusMeaning("Job", code, t)).toMatch(new RegExp(`^${code}: `));
    expect(shared.codes.map(statusRole)).toEqual([
      "neutral",
      "err",
      "warn",
      "warn",
      "ok",
      "pending",
    ]);
  });
});
