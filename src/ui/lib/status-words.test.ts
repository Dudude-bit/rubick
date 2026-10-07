import { describe, expect, it } from "vite-plus/test";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import { cronStatusWord, ownStatusWord } from "./status-words";

const ru: T = (section, key, values) => translate("ru", section, key, values);

describe("the words of a status that are the app's", () => {
  /**
   * `Suspended` (from spec.suspend) and `Waiting` (an unobserved generation)
   * sat in English beside Russian sentences. Fails if either goes back to the
   * raw code.
   */
  it("words the two codes this app composes in the reader's language", () => {
    expect(ownStatusWord("Suspended", ru)).toBe("Приостановлен");
    expect(ownStatusWord("Waiting", ru)).toBe("Ожидает");
    expect(cronStatusWord(true, ru)).toBe("Приостановлен");
    expect(cronStatusWord(false, ru)).toBe("Активен");
  });

  /**
   * A Namespace's phase `Active` and a Pod's `Running` are what the cluster
   * wrote and are matched against kubectl. Fails if the mapping widens to a
   * word the cluster owns.
   */
  it("leaves every status the cluster writes as it wrote it", () => {
    for (const code of ["Active", "Running", "Complete", "Failed", "Stalled"]) {
      expect(ownStatusWord(code, ru)).toBeUndefined();
    }
  });
});
