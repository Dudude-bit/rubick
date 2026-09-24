import { describe, expect, it } from "vitest";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import {
  applicationsNeedAttention,
  hostsBrokenOfTotal,
  hostsNeedAttention,
  valuesCopiedWithBinary,
} from "./two-counts";

const inLanguage =
  (language: "en" | "ru"): T =>
  (section, key, values) =>
    translate(language, section, key, values);
const ru = inLanguage("ru");
const en = inLanguage("en");

/** The second count wore the first one's form: "1 из 1 хостов",
 *  "1 of 5 host needs attention", "1 двоичных". */
describe("a sentence with two counts", () => {
  it("declines each count by its own number", () => {
    expect(hostsNeedAttention(1, 1, ru)).toBe("1 из 1 хоста требует внимания");
    expect(hostsNeedAttention(2, 5, ru)).toBe("2 из 5 хостов требуют внимания");
    expect(hostsNeedAttention(1, 5, en)).toBe("1 of 5 hosts needs attention");
    expect(hostsBrokenOfTotal(1, 1, ru)).toBe("1 из 1 хоста сломан");
    expect(applicationsNeedAttention(1, 1, en)).toBe(
      "1 of 1 application needs attention"
    );
    expect(applicationsNeedAttention(3, 21, ru)).toBe(
      "3 из 21 приложения требуют внимания"
    );
    expect(valuesCopiedWithBinary(5, 1, ru)).toBe(
      "Скопировано 5 значений, 1 двоичное — в base64."
    );
  });
});

/** Counts that sat in plain strings: "из 1 узлов", "5 вещи отменят это",
 *  "1 строк, 1 ошибок", "до 1 реплик", "1 of 1 nodes". */
describe("counts in the catalogue", () => {
  const ofNodes = (t: T, n: number) => t("count", "ofNodes", { n });

  it("declines each count by its own number", () => {
    expect(ru("count", "nodesReady", { n: 1, of: ofNodes(ru, 1) })).toBe(
      "готово 1 из 1 узла"
    );
    expect(en("count", "nodesReady", { n: 1, of: ofNodes(en, 1) })).toBe(
      "1 of 1 node ready"
    );
    expect(
      ru("count", "podsRunning", {
        n: 3,
        of: ru("count", "ofPods", { n: 5 }),
      })
    ).toBe("работает 3 из 5 подов");
    expect(ru("readings", "warnUndoThis", { n: 5, count: "5" })).toBe(
      "5 вещей отменят это."
    );
    expect(ru("readings", "warnUndoThis", { n: 2, count: "Две" })).toBe(
      "Две вещи отменят это."
    );
    expect(ru("readings", "hpaRange", { min: 1, n: 1 })).toBe(
      "от 1 до 1 реплики"
    );
    expect(ru("readings", "problemReplicasReady", { ready: 0, n: 3 })).toBe(
      "готово 0 из 3 реплик"
    );
    expect(ru("count", "podsReadySlash", { ready: 1, n: 1 })).toBe(
      "готово 1/1 пода"
    );
    expect(ru("readings", "ngxHstsAge", { n: 31536000 })).toBe(
      "Браузеру велено помнить это 31536000 секунд."
    );
    expect(
      ru("count", "densityTotals", {
        lines: ru("count", "densityLines", { n: 1, count: "1" }),
        errors: ru("count", "densityErrors", { n: 2, count: "2" }),
        warnings: ru("count", "densityWarnings", { n: 5, count: "5" }),
      })
    ).toBe("1 строка, 2 ошибки, 5 предупреждений.");
    expect(
      ru("action", "historyLimits", {
        succeeded: ru("action", "jobsSucceeded", { n: 1 }),
        failed: ru("action", "jobsFailed", { n: 3 }),
      })
    ).toBe("хранится 1 успешный · 3 неудачных");
    expect(
      ru("operators", "nodesSetUp", { tuned: 1, of: ofNodes(ru, 1) })
    ).toBe("1 из 1 узла подготовлено");
  });
});
