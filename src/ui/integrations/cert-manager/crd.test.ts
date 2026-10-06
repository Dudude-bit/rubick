import { createElement, Fragment, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import { crd } from "./crd";

const ru: T = (section, key, values) => translate("ru", section, key, values);

const cell = (view: typeof crd, kind: string, id: string, value: unknown) => {
  const column = view.columnsFor(kind).find((c) => c.id === id);
  return column?.cell?.(value, ru);
};

const drawn = (node: unknown) =>
  renderToStaticMarkup(
    createElement(Fragment, null, node as ReactNode)
  ).replace(/<[^>]+>/g, "");

describe("what a vendor's list cells say in Russian", () => {
  /**
   * An unissued Certificate has no status.notAfter yet. Drawn as "-" it read
   * like any empty field; as "none" it would read as never expiring.
   */
  it("says an unissued Certificate's expiry is not written yet", () => {
    expect(drawn(cell(crd, "Certificate", "expiry", undefined))).toBe(
      "ещё не записано"
    );
    expect(drawn(cell(crd, "Certificate", "secret", undefined))).not.toBe("-");
  });

  /**
   * "3 names", "12 days" and "Default" were composed in code and printed
   * into Russian tables as they were.
   */
  it("counts and dates a Certificate in the reader's language", () => {
    expect(cell(crd, "Certificate", "dnsNames", 3)).toBe("3 имени");
    expect(cell(crd, "Certificate", "dnsNames", 5)).toBe("5 имён");
    const inTwelveDays = new Date(Date.now() + 12.5 * 86400_000).toISOString();
    expect(cell(crd, "Certificate", "expiry", inTwelveDays)).toBe(
      "через 12 дней"
    );
    const past = new Date(Date.now() - 86400_000 * 2).toISOString();
    expect(cell(crd, "Certificate", "expiry", past)).toBe("Истёк");
  });
});
