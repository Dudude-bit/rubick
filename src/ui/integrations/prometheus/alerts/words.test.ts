import { describe, expect, it } from "vitest";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import { firingWords } from "./words";
import { verdictOf } from "./verdict";
import type { RuleRow } from "./model";
import { verdictOf as verdictOfMonitor } from "../monitors/verdict";
import type { MonitorRow } from "../monitors/model";

const inLanguage =
  (language: "en" | "ru"): T =>
  (section, key, values) =>
    translate(language, section, key, values);

describe("the alerts headline", () => {
  /** Both counts shared the alerts' plural, so four alerts in one object
   *  read "в 1 объектах правил" and "across 1 rule objects". */
  it("declines the rule-object count by its own number", () => {
    expect(firingWords(4, 1, inLanguage("ru"))).toBe(
      "4 алерта горят в 1 объекте правил"
    );
    expect(firingWords(1, 3, inLanguage("ru"))).toBe(
      "1 алерт горит в 3 объектах правил"
    );
    expect(firingWords(4, 1, inLanguage("en"))).toBe(
      "4 alerts firing in 1 rule object"
    );
  });
});

describe("the alerts verdict", () => {
  const row = (kind: "firing" | "pending") =>
    ({
      findings: [{ kind, severity: "err", alerts: 4, rules: 1 }],
    }) as never as RuleRow;

  /** "4 алерта горят из 1 правил." — the rule count took the alerts' plural. */
  it("declines the rule count by its own number", () => {
    expect(verdictOf(row("firing"), 1, inLanguage("ru")).head).toBe(
      "4 алерта горят из 1 правила."
    );
    expect(verdictOf(row("pending"), 1, inLanguage("en")).head).toBe(
      "4 alerts pending from 1 rule, not yet past their for clauses."
    );
  });
});

describe("the monitors verdict", () => {
  const down = (n: number, total: number) =>
    ({
      findings: [
        {
          kind: "targetsDown",
          severity: "err",
          down: n,
          total,
          lastError: null,
        },
      ],
    }) as never as MonitorRow;

  /** "1 из 1 target'ов down." — the total's noun ignored the total. */
  it("declines the target total by its own number", () => {
    expect(
      verdictOfMonitor(down(1, 1), 1, null, null, inLanguage("ru")).head
    ).toBe("1 из 1 target'а down.");
    expect(
      verdictOfMonitor(down(1, 1), 1, null, null, inLanguage("en")).head
    ).toBe("1 of 1 target down.");
  });
});
