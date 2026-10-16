/**
 * The line above the list is the first thing read, and it used to answer a
 * question nobody had asked the cluster. With no Prometheus connected every
 * row says "unchecked" and the headline said "all scraped" over them — the
 * third state collapsing into the second, in the one sentence that sets the
 * reader's expectation for the whole page.
 */

import { describe, expect, it } from "vite-plus/test";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import { headlineKey, picksUpWords } from "./words";
import type { Picture } from "./data";
import type { MonitorRow } from "./model";

const picture = (
  targets: unknown,
  serviceMonitors: unknown = { state: "read", items: [] }
): Picture =>
  ({
    serviceMonitors,
    podMonitors: { state: "read", items: [] },
    prometheuses: { state: "absent" },
    services: { ok: true, items: [] },
    namespaces: { ok: true, items: [] },
    targets,
  }) as unknown as Picture;

const row = (worst: string | null): MonitorRow =>
  ({ worst, findings: [] }) as unknown as MonitorRow;

const READ = { state: "read", targets: [] };

describe("the headline above the monitor list", () => {
  it("does not claim a scrape when no Prometheus is connected", () => {
    expect(headlineKey(picture({ state: "notConnected" }), [row(null)])).toBe(
      "scrapeUnchecked"
    );
  });

  it("does not claim a scrape when the connected Prometheus never answered", () => {
    expect(
      headlineKey(picture({ state: "unanswered", reason: "timed out" }), [
        row(null),
      ])
    ).toBe("scrapeUnchecked");
  });

  it("claims the scrape only once the targets have been read", () => {
    expect(headlineKey(picture(READ), [row(null)])).toBe("allScraped");
  });

  it("says a list was refused before it says anything about scraping", () => {
    expect(
      headlineKey(picture(READ, { state: "unread", reason: "forbidden" }), [
        row(null),
      ])
    ).toBe("someUnread");
  });

  it("counts what needs attention even with the targets unread", () => {
    expect(headlineKey(picture({ state: "notConnected" }), [row("err")])).toBe(
      "needAttention"
    );
  });
});

describe("what a Prometheus picks up, in words", () => {
  const en = ((
    section: string,
    key: string,
    values?: Record<string, unknown>
  ) => translate("en", section as never, key as never, values as never)) as T;

  /**
   * Absent, the monitor selector picks up nothing; the sentence read
   * "monitors matching" over an empty selector as if it picked something.
   */
  it("says a Prometheus with no monitor selector picks up none", () => {
    expect(picksUpWords(null, {}, en)).toBe(
      translate("en", "monitors", "picksUpNone")
    );
  });

  /** A selector Kubernetes would not build says nothing about what it picks. */
  it("says a selector Kubernetes would not build picks nothing it can name", () => {
    const broken = { matchExpressions: [{ key: "app", operator: "Near" }] };
    expect(picksUpWords(broken as never, {}, en)).toBe(
      translate("en", "monitors", "picksUpUnevaluable")
    );
  });

  /** `{}` is every monitor, and where from depends on the namespace selector. */
  it.each([
    [{}, "picksUpAll"],
    [null, "picksUpOwn"],
  ] as const)(
    "reads an empty monitor selector with namespaces %j",
    (scope, key) => {
      expect(picksUpWords({}, scope, en)).toBe(
        translate("en", "monitors", key)
      );
    }
  );
});
