/**
 * The line above the list is the first thing read, and it used to answer a
 * question nobody had asked the cluster. With no Prometheus connected every
 * row says "unchecked" and the headline said "all scraped" over them — the
 * third state collapsing into the second, in the one sentence that sets the
 * reader's expectation for the whole page.
 */

import { describe, expect, it } from "vitest";

import { headlineKey } from "./words";
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
