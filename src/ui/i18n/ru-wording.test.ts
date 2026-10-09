import { describe, expect, it } from "vite-plus/test";

import { translate } from "@/i18n";
import { en, type Plural } from "./catalogue";
import { ru } from "./ru";

const CARRYING = /(?<![\p{L}])нес(?:ёт|ут|ёшь|у|ли|ла|ло)(?![\p{L}])/iu;

function strings(): Array<[string, string]> {
  return Object.entries(ru).flatMap(([section, keys]) =>
    Object.entries(keys as Record<string, string | Plural>).flatMap(
      ([key, value]): Array<[string, string]> =>
        typeof value === "string"
          ? [[`${section}.${key}`, value]]
          : Object.entries(value).map(([form, text]) => [
              `${section}.${key}.${form}`,
              String(text),
            ])
    )
  );
}

describe("Russian written as a person says it", () => {
  /**
   * Lena read "Ответы несут версию nginx", "Error log несёт всё" and "какой
   * Gateway несёт app-tls": English "carries" with a Russian verb on it, for
   * a label, a log level and a set of listeners. Fails when any string says
   * something is carried again.
   */
  it("never says an object, a log or a header carries something", () => {
    const offenders = strings()
      .filter(([, text]) => CARRYING.test(text))
      .map(([id]) => id);
    expect(offenders).toEqual([]);
  });

  /** The hint under Ports not exposed names what is compared, in words a Russian reader has. */
  it("says a slice's ports are matched to the Service's by name", () => {
    expect(translate("ru", "empty", "portsNotExposedHint")).toBe(
      "В срезе порты привязаны к портам Service по имени. Имена этих портов не совпадают ни с одним из объявленных в срезе, поэтому к ним ничего не маршрутизируется."
    );
  });

  /** Lena found "admission control" left in English mid-sentence on Ваш доступ; fails if the caveat drops back to the English term. */
  it("names admission control in Russian in the access caveat", () => {
    const caveat = translate("ru", "myAccess", "caveat");
    expect(caveat).not.toMatch(/admission/i);
    expect(caveat).toContain("контроллеры допуска");
  });

  /** Lena read the Owns tab as "Owner", the opposite of what it lists; fails if the tab is a word for an owner or a verb again. */
  it("names the Owns tab for what it lists, a noun beside its Owners counterpart", () => {
    const tab = translate("ru", "owns", "tab");
    expect(tab).toBe("Зависимые");
    expect(tab).not.toMatch(/владе/i);
    expect(translate("ru", "lineage", "label")).toBe("Владельцы");
  });
});

describe("an open-ended count", () => {
  /**
   * Marco's Russian picker read "3+ проблемы", the form for exactly three:
   * after "3+" the noun is counted as "more than three", in the genitive,
   * whatever the number. Fails if a count written "{n}+" picks its noun by
   * the number in either language, or Russian drops the genitive.
   */
  it("says its noun in one form whatever the number", () => {
    const byNumber = [en, ru].flatMap((catalogue) =>
      Object.entries(catalogue).flatMap(([section, keys]) =>
        Object.entries(keys as Record<string, string | Plural>)
          .filter(
            ([, value]) =>
              typeof value !== "string" &&
              value.other.includes("{n}+") &&
              Object.keys(value).length > 1
          )
          .map(([key]) => `${section}.${key}`)
      )
    );
    expect(byNumber).toEqual([]);
    expect(translate("ru", "cluster", "problemCountAtLeast", { n: 3 })).toBe(
      "3+ проблем"
    );
    expect(translate("ru", "cluster", "problemCountAtLeast", { n: 1 })).toBe(
      "1+ проблем"
    );
  });
});

describe("a verb beside a count", () => {
  /**
   * A flat string has one form for every number: "{n} из {total} требуют
   * внимания" said "1 из 4 требуют", and "готовы {ready} из {total}" said
   * "готовы 1 из 3". Fails if a plural verb or short adjective stands next to
   * a count in a string that is not a Plural.
   */
  it("never stands next to a count in a flat string", () => {
    const count = String.raw`\{(?:n|ready|healthy|count|done|available)\}`;
    const after = new RegExp(
      String.raw`${count}(?: из \{\w+\})? (?:не )?[а-яё]+(?:ют|ят|ются|ятся|ы|ли|лись)(?![а-яё])`,
      "i"
    );
    const before = new RegExp(
      String.raw`(?:^|[\s:,])[а-яё]+(?:ы|ют|ят|ются|ятся) ${count}`,
      "i"
    );
    const flat = Object.entries(ru).flatMap(([section, keys]) =>
      Object.entries(keys as Record<string, string | Plural>)
        .filter(
          ([, value]) =>
            typeof value === "string" &&
            (after.test(value) || before.test(value))
        )
        .map(([key]) => `${section}.${key}`)
    );
    expect(flat).toEqual([]);
  });

  /** One draining, one needing attention, one not reconciling: each in the singular. */
  it("puts the verb in the singular beside one", () => {
    const say = (section: "count" | "monitors", key: string, n: number) =>
      translate("ru", section, key as never, { n, total: 4 });
    expect(say("count", "nDraining", 1)).toBe("1 завершается");
    expect(say("count", "nDraining", 3)).toBe("3 завершаются");
    expect(say("monitors", "needAttention", 1)).toBe("1 из 4 требует внимания");
    expect(say("count", "notReconcilingAndFirst", 1)).toBe(
      "1 из 4 не согласуется, такие идут первыми"
    );
    expect(say("count", "ofTotalReady", 1)).toBe("готово 1 из 4");
  });
});

describe("the Russian word for a drain", () => {
  /**
   * "Слив ждёт" and "что должен учитывать слив" on Lena's cart Deployment
   * read as a dump or a leak. A node drain is an освобождение, as the drain
   * dialog already says. Fails if "слив" comes back anywhere.
   */
  it("is never слив", () => {
    const found = strings().filter(([, text]) => /слив/i.test(text));
    expect(found).toEqual([]);
  });
});

describe("the Russian name for a disruption budget", () => {
  /**
   * Lena read "Бюджет простоя" on a pod's Links tab and "бюджеты прерываний"
   * in the drain dialog, for one PodDisruptionBudget. Fails if a second name
   * for it comes back anywhere.
   */
  it("is бюджет прерываний wherever it is named", () => {
    expect(translate("ru", "nav", "disruptionBudget")).toBe(
      "Бюджет прерываний"
    );
    const other = strings().filter(([, text]) =>
      /бюджет\S*\s+простоя/i.test(text)
    );
    expect(other).toEqual([]);
  });
});
