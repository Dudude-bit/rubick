import { describe, expect, it } from "vite-plus/test";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import { coverWords, errorWords } from "./say";

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

describe("the words for a stretch events covered", () => {
  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;
  const ru: T = (section, key, values) => translate("ru", section, key, values);

  /**
   * Marco's stories read "881 times within 4 hours" for 4 h 19 min and "within
   * 1 hour" for 1 h 43 min. Fails if a span is ever said shorter than it was.
   */
  it("never says a stretch shorter than it was", () => {
    expect(coverWords(HOUR + 43 * MINUTE, t)).toBe("1 hour 43 minutes");
    expect(coverWords(4 * HOUR + 19 * MINUTE + 10_000, t)).toBe(
      "4 hours 20 minutes"
    );
    expect(coverWords(2 * HOUR, t)).toBe("2 hours");
    expect(coverWords(59 * MINUTE + 1000, t)).toBe("1 hour");
    expect(coverWords(5000, t)).toBe("1 minute");
    expect(coverWords(26 * HOUR + 1000, t)).toBe("1 day 3 hours");
  });

  /** Russian puts the minutes in the accusative inside "за ...". Fails if the sentence form is lost. */
  it("keeps Russian's sentence form for the minutes", () => {
    expect(coverWords(HOUR + 21 * MINUTE, ru)).toBe("1 час 21 минуту");
    expect(coverWords(HOUR + 21 * MINUTE, ru, "alone")).toBe("1 час 21 минута");
  });
});
