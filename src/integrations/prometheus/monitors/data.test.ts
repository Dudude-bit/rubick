/**
 * The sidebar row carries the monitor count, and a count is a claim. A list
 * the cluster refused used to fall through to `rowsOfPicture(...).length`,
 * which silently drops an `unread` kind — so a 403 on ServiceMonitors put a
 * confident **0** beside a page that was saying, at the same moment, that it
 * could not look. The row is better with no number on it.
 */

import { describe, expect, it } from "vitest";

import { alertsMark, monitorCount, monitorMark, type Picture } from "./data";

const empty = {
  services: { ok: true, items: [] },
  namespaces: { ok: true, items: [] },
  targets: { state: "none" },
} as unknown as Picture;

const picture = (serviceMonitors: unknown, podMonitors: unknown): Picture =>
  ({
    ...empty,
    serviceMonitors,
    podMonitors,
    prometheuses: { state: "absent" },
  }) as unknown as Picture;

describe("the number the sidebar row carries", () => {
  it("has none when a monitor list was refused", () => {
    expect(
      monitorCount(
        picture(
          { state: "unread", reason: "servicemonitors is forbidden" },
          { state: "read", items: [] }
        )
      )
    ).toBeNull();
  });

  it("has none when neither kind is installed", () => {
    expect(
      monitorCount(picture({ state: "absent" }, { state: "absent" }))
    ).toBeNull();
  });

  it("says zero when both lists answered and held nothing", () => {
    expect(
      monitorCount(
        picture({ state: "read", items: [] }, { state: "read", items: [] })
      )
    ).toBe(0);
  });
});

/**
 * The third reader of the same number. The sidebar row and the page header
 * both learned that a refused list is not an empty one; the tab mark kept
 * counting the rows that survived, so a 403 on ServiceMonitors drew a
 * confident number beside a header saying some lists could not be read.
 */
describe("the mark the Monitors tab carries", () => {
  it("carries nothing when a monitor list was refused", () => {
    expect(
      monitorMark(
        picture(
          { state: "unread", reason: "servicemonitors is forbidden" },
          { state: "read", items: [] }
        )
      )
    ).toBeNull();
  });

  it("carries a count when both lists answered", () => {
    expect(
      monitorMark(
        picture({ state: "read", items: [] }, { state: "read", items: [] })
      )
    ).toEqual({ shows: "count", of: 0 });
  });

  /**
   * And the same number in the other sentence: a row that needs attention
   * came from the list that answered, so "1 of 1" over a refused list is
   * the confident total again, one word further along.
   */
  it("claims no total when one of the lists was refused", () => {
    const mark = monitorMark(
      picture(
        { state: "unread", reason: "servicemonitors is forbidden" },
        { state: "read", items: [] }
      )
    );
    expect(
      mark === null || mark.shows !== "severity" || mark.total === null
    ).toBe(true);
  });
});

/**
 * The tab's mark and the rail's dot are the worst thing on the page, and the
 * page grew an Alerts tab. Both were built from the firing alerts alone, so
 * a rule object nothing picks up left a plain count on the tab and nothing
 * at all on the dot.
 */
describe("what the Alerts tab and the sidebar dot carry", () => {
  const withRules = (over: Partial<Picture>): Picture =>
    ({
      ...empty,
      serviceMonitors: { state: "read", items: [] },
      podMonitors: { state: "read", items: [] },
      prometheuses: { state: "read", items: [] },
      namespaces: { ok: true, items: [] },
      rules: { state: "read", items: [] },
      alertRules: { state: "read", rules: [] },
      ...over,
    }) as unknown as Picture;

  it("says nothing louder than a count when every rule object is quiet", () => {
    const mark = alertsMark(withRules({}));
    expect(mark).toEqual({ shows: "count", of: 0 });
  });

  it("has no mark at all while the rule objects have not been read", () => {
    expect(
      alertsMark(
        withRules({ rules: { state: "unread", reason: "403" } } as never)
      )
    ).toBeNull();
  });
});
