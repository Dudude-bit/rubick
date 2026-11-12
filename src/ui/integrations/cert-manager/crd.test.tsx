import { createElement, Fragment, type ReactNode } from "react";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";

import type { CustomResourceInfo } from "@/generated/types";
import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import { crd } from "./crd";

const ru: T = (section, key, values) => translate("ru", section, key, values);

const cell = (view: typeof crd, kind: string, id: string, value: unknown) => {
  const column = view.columnsFor(kind).find((c) => c.id === id);
  return column?.cell?.(value, ru);
};

const drawn = (node: unknown) =>
  render(createElement(Fragment, null, node as ReactNode)).container
    .textContent;

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

describe("the Ready column of cert-manager's lists", () => {
  const en: T = (section, key, values) => translate("en", section, key, values);

  function ready(kind: string, conditions: unknown) {
    const column = crd.columnsFor(kind).find((one) => one.id === "ready")!;
    const resource = { status: { conditions } } as CustomResourceInfo;
    return drawn(column.cell!(column.accessor(resource, en), en));
  }

  /**
   * `status === "True" ? "True" : "False"` printed "False" for a Ready that
   * is `Unknown` and for one cert-manager had not written yet, so an object
   * it had not answered about read as failed.
   */
  it.each(["Certificate", "Issuer", "ClusterIssuer"])(
    "says a %s's Ready as cert-manager wrote it, and never False for one it did not",
    (kind) => {
      expect(ready(kind, [{ type: "Ready", status: "True" }])).toBe("True");
      expect(ready(kind, [{ type: "Ready", status: "False" }])).toBe("False");
      expect(ready(kind, [{ type: "Ready", status: "Unknown" }])).toBe(
        "Unknown"
      );
      expect(ready(kind, [{ type: "Issuing", status: "True" }])).toBe(
        "not written yet"
      );
      expect(ready(kind, undefined)).toBe("not written yet");
    }
  );
});
