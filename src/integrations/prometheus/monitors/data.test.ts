/**
 * The sidebar row carries the monitor count, and a count is a claim. A list
 * the cluster refused used to fall through to `rowsOfPicture(...).length`,
 * which silently drops an `unread` kind — so a 403 on ServiceMonitors put a
 * confident **0** beside a page that was saying, at the same moment, that it
 * could not look. The row is better with no number on it.
 */

import { describe, expect, it } from "vitest";

import { monitorCount, type Picture } from "./data";

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
