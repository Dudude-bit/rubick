import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import { changesScreenSection, watchedSection } from "./changes-share";

const t: T = (section, key, values) => translate("en", section, key, values);

const from = Date.UTC(2026, 8, 25, 3, 7);
const to = Date.UTC(2026, 8, 25, 4, 42);

let zone: string | undefined;
beforeEach(() => {
  zone = process.env.TZ;
  process.env.TZ = "Asia/Tokyo";
});
afterEach(() => {
  process.env.TZ = zone;
});

describe("the times a shared Changes report prints", () => {
  /** The sender's local clock went into the file unmarked, and a reader in
   *  another zone read the gap as a different stretch of the day. */
  it("prints a gap's ends in UTC and says so", () => {
    const section = changesScreenSection(
      [{ kind: "gap", at: to, gap: { from, to } }],
      t
    );
    if (section.body.type !== "changes") throw new Error("expected changes");
    const text = section.body.changes[0].parts[0].text;
    expect(text).toMatch(/\b0?3:07\b.* UTC/);
    expect(text).toMatch(/\b0?4:42\b.* UTC$/);
  });

  it("prints when watching started in UTC", () => {
    const section = watchedSection({ from, seenAt: to, to: null }, 0, t);
    if (section.body.type !== "text") throw new Error("expected text");
    expect(section.body.text).toMatch(/\b0?3:07\b.* UTC/);
  });
});
