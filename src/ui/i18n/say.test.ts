import { describe, expect, it } from "vitest";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import { errorWords } from "./say";

const t: T = (section, key, values) => translate("en", section, key, values);

describe("the words for a caught error", () => {
  /**
   * The toast on a failed ConfigMap save, a failed sidebar action or a failed
   * integration connect read "Tauri command 'x' failed:" before the server's
   * own sentence.
   */
  it("gives the server's words without the command in front", () => {
    expect(
      errorWords(
        new Error(
          "Tauri command 'updateConfigmap' failed: configmaps \"app\" is forbidden"
        ),
        t
      )
    ).toBe('configmaps "app" is forbidden');
  });
});
