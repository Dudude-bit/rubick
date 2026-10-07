import { describe, expect, it } from "vite-plus/test";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import { cronStatusWord, ownStatusWord } from "./status-words";

const ru: T = (section, key, values) => translate("ru", section, key, values);

describe("the words of a status that are the app's", () => {
  /**
   * `Suspended` (from spec.suspend), `Waiting` (an unobserved generation) and
   * the verdicts Idle, Stalled, Degraded and Retrying sat in English beside
   * Russian sentences. Fails if any goes back to the raw code.
   */
  it("words the codes this app composes in the reader's language", () => {
    expect(ownStatusWord("Suspended", ru)).toBe("Приостановлен");
    expect(ownStatusWord("Waiting", ru)).toBe("Ожидает");
    expect(ownStatusWord("Idle", ru)).toBe("Простаивает");
    expect(ownStatusWord("Stalled", ru)).toBe("Застрял");
    expect(ownStatusWord("Degraded", ru)).toBe("Деградировал");
    expect(ownStatusWord("Retrying", ru)).toBe("Повторяет попытку");
    expect(cronStatusWord(true, ru)).toBe("Приостановлен");
    expect(cronStatusWord(false, ru)).toBe("Активен");
  });

  /**
   * A Namespace's phase `Active` and a Pod's `Running` are what the cluster
   * wrote and are matched against kubectl. Fails if the mapping widens to a
   * word the cluster owns.
   */
  it("leaves every status the cluster writes as it wrote it", () => {
    for (const code of [
      "Active",
      "Running",
      "Complete",
      "Failed",
      "Unavailable",
      "Paused",
      "Progressing",
      "Ready",
      "Pending",
    ]) {
      expect(ownStatusWord(code, ru)).toBeUndefined();
    }
  });
});
