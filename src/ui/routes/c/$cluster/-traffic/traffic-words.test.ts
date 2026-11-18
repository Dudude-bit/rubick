import { describe, expect, it } from "vite-plus/test";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import { liveRow } from "@/lib/traffic";
import {
  cellText,
  cellTitle,
  coverageWords,
  MEASURE_WORD,
  WINDOW_WORD,
} from "./traffic-words";

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

describe("the rail's sentence about a mesh", () => {
  const say =
    (locale: "en" | "ru"): T =>
    (section, key, values) =>
      translate(locale, section, key, values);

  /**
   * "every pod of 8, some pods of 0, of 19 workloads here" read as
   * arithmetic: the parts are said as counts of the workloads, and a part
   * that is zero is left out.
   */
  it("says how many workloads are in the mesh whole, in part and not at all, leaving out a zero", () => {
    const en = say("en");
    expect(
      coverageWords(
        { source: 0, workloads: 19, marked: 8, partly: 0 },
        "Istio",
        en
      )
    ).toBe(
      "In Istio's mesh, of 19 workloads here: 8 with every pod, 11 with none."
    );
    expect(
      coverageWords(
        { source: 0, workloads: 5, marked: 2, partly: 3 },
        "Istio",
        en
      )
    ).toBe(
      "In Istio's mesh, of 5 workloads here: 2 with every pod, 3 with some pods."
    );
    expect(
      coverageWords(
        { source: 0, workloads: 19, marked: 8, partly: 2 },
        "Istio",
        say("ru")
      )
    ).toBe(
      "В меше Istio из 19 нагрузок здесь: 8 всеми подами, 2 частью подов, 9 ни одним."
    );
  });
});

describe("a cell a source sees only below HTTP", () => {
  /** "none" read as "there were no requests"; the cell is blank and its title says why, in both modes. */
  it("is blank, and its title says the pair is seen only below HTTP", () => {
    const t: T = (section, key, values) =>
      translate("en", section, key, values);
    const row = liveRow({
      from: { is: "address", address: "10.0.0.1" },
      to: { is: "address", address: "10.0.0.2" },
      forwarded: 1,
      dropped: 0,
      drops: [],
      requests: null,
      errors: null,
      p50: null,
      p95: null,
      p99: null,
      protocols: [],
    });
    expect(cellText(row.requests, "rate", t)).toBe("");
    expect(cellTitle(row.p95, row, t)).toBe(
      "Hubble Relay: this pair is seen only below HTTP, so its requests, errors and latency are not counted."
    );
  });
});
