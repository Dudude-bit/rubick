import { describe, expect, it } from "vite-plus/test";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import { ROLLOUT_CODES } from "./workload-status";
import {
  cronStatusWord,
  ownStatusWord,
  rolloutCountedWord,
  rolloutWord,
} from "./status-words";

const ru: T = (section, key, values) => translate("ru", section, key, values);

describe("the words of a status that are the app's", () => {
  /**
   * `Suspended` (from spec.suspend) and the Job verdict Retrying sat in
   * English beside Russian sentences. Fails if either goes back to the raw
   * code.
   */
  it("words the Job codes this app composes in the reader's language", () => {
    expect(ownStatusWord("Suspended", ru)).toBe("Приостановлен");
    expect(ownStatusWord("Retrying", ru)).toBe("Повторяет попытку");
    expect(cronStatusWord(true, ru)).toBe("Приостановлен");
    expect(cronStatusWord(false, ru)).toBe("Активен");
  });

  /**
   * Marco's Russian legend read "1 Ready  1 застрял  1 Unavailable": Stalled
   * worded, its siblings not. A Deployment's, StatefulSet's or DaemonSet's
   * status holds none of the rollout words, so every one is the app's. Fails
   * if any rollout verdict, as a badge or counted, prints its English code.
   */
  it("words every rollout verdict, as a badge and counted", () => {
    expect(
      Object.fromEntries(
        [...new Set(Object.values(ROLLOUT_CODES))].map((code) => [
          code,
          [rolloutWord(code, ru), rolloutCountedWord(code, 2, ru)],
        ])
      )
    ).toEqual({
      Idle: ["Простаивает", "простаивают"],
      Stalled: ["Застрял", "застряли"],
      Unavailable: ["Недоступен", "недоступны"],
      Paused: ["На паузе", "на паузе"],
      Waiting: ["Ожидает", "ожидают"],
      Progressing: ["Развёртывается", "развёртываются"],
      Degraded: ["Деградировал", "деградировали"],
      Ready: ["Готов", "готовы"],
    });
  });

  /**
   * A Namespace's phase `Active`, a Pod's `Running`, a Job's Complete and
   * Failed, and Argo CD's Progressing health are what the cluster wrote and
   * are matched against kubectl. Fails if the Job wording widens to a word
   * the cluster owns.
   */
  it("leaves every status the cluster writes as it wrote it", () => {
    for (const code of [
      "Active",
      "Running",
      "Complete",
      "Failed",
      "Progressing",
      "Ready",
      "Pending",
    ]) {
      expect(ownStatusWord(code, ru)).toBeUndefined();
    }
  });
});
