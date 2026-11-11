import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

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

  /** A quiet stretch in the file is as much a claim as on the page. Fails if its row drops what the watch was refused. */
  it("says what a quiet stretch's watch was refused", () => {
    const section = changesScreenSection(
      [
        {
          kind: "watched",
          quiet: true,
          at: to,
          gap: { from, to },
          refused: { unwatched: ["DaemonSet"] },
        },
      ],
      t
    );
    if (section.body.type !== "changes") throw new Error("expected changes");
    expect(section.body.changes[0].parts.map((part) => part.text)).toEqual([
      expect.stringMatching(/^Watched .+: nothing here changed$/),
      "DaemonSet not watched across the cluster: the cluster refused",
    ]);
  });

  /** Fails if the file calls a stretch that recorded rows quiet, or leaves out what its watch was refused. */
  it("says what a stretch with rows was refused without calling it quiet", () => {
    const section = changesScreenSection(
      [
        {
          kind: "watched",
          quiet: false,
          at: to,
          gap: { from, to },
          refused: { unwatched: ["DaemonSet"] },
        },
      ],
      t
    );
    if (section.body.type !== "changes") throw new Error("expected changes");
    expect(section.body.changes[0].parts.map((part) => part.text)).toEqual([
      expect.stringMatching(/^Watched .+ UTC$/),
      "DaemonSet not watched across the cluster: the cluster refused",
    ]);
  });

  /** Fails if the file's quiet line speaks for a kind the running watch was refused everywhere. */
  it("names only the kinds the running watch watches as quiet", () => {
    const span = { from, seenAt: to, to: null, unwatched: ["DaemonSet"] };
    const section = watchedSection(span, [span], [], t);
    if (section.body.type !== "text") throw new Error("expected text");
    expect(section.body.text).toContain(
      "of the Deployments and StatefulSets this app watches here"
    );
    const whole = { from, seenAt: to, to: null };
    const all = watchedSection(whole, [whole], [], t);
    expect(all.body.type === "text" && all.body.text).toContain(
      "of the Deployments, StatefulSets, and DaemonSets this app watches here"
    );
  });

  it("prints when watching started in UTC", () => {
    const span = { from, seenAt: to, to: null };
    const section = watchedSection(span, [span], [], t);
    if (section.body.type !== "text") throw new Error("expected text");
    expect(section.body.text).toMatch(/\b0?3:07\b.* UTC/);
  });
});
