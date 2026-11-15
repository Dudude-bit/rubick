import { describe, expect, it } from "vite-plus/test";

import { translate } from "@/i18n";
import { MEASURE_WORD, WINDOW_WORD } from "./traffic-words";

const ru = (key: Parameters<typeof translate<"traffic">>[2], values = {}) =>
  translate("ru", "traffic", key, values);

describe("the Russian traffic sentences that take a word in", () => {
  /**
   * The window words are nominatives ("последняя минута"), so a sentence
   * that puts one after «за» declines it wrongly: «за последняя минута».
   */
  it("never puts a window word after a preposition that would decline it", () => {
    for (const window of [
      ru("lastMinute"),
      ...Object.values(WINDOW_WORD).map((key) => ru(key)),
    ]) {
      const said = ru("nothingInWindow", {
        sources: "Hubble",
        scope: "prod",
        window,
      });
      expect(said).toContain(`(${window})`);
      expect(said).not.toContain(`за ${window}`);
    }
  });

  /** «прочитать» takes the accusative, and the measure words are nominatives: «прочитать задержка p50». */
  it("names a failed measure in a form its sentence does not decline", () => {
    for (const key of Object.values(MEASURE_WORD)) {
      const measure = ru(key);
      const said = ru("measureFailed", { measure, said: "timeout" });
      expect(said).toContain(`«${measure}»`);
    }
  });
});
