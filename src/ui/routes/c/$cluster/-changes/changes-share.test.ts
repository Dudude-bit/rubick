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
      t,
      "24h"
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
      t,
      "24h"
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
      t,
      "24h"
    );
    if (section.body.type !== "changes") throw new Error("expected changes");
    expect(section.body.changes[0].parts.map((part) => part.text)).toEqual([
      expect.stringMatching(/^Watched .+ UTC$/),
      "DaemonSet not watched across the cluster: the cluster refused",
    ]);
  });

  /** Fails if the file's quiet line speaks for a kind the running watch was refused everywhere. */
  it("names only the kinds the running watch watches as quiet", () => {
    const kinds = ["Deployment", "StatefulSet", "DaemonSet"];
    const span = {
      from,
      seenAt: to,
      to: null,
      unwatched: ["DaemonSet"],
      kinds,
    };
    const section = watchedSection(span, [span], [], t, "all");
    if (section.body.type !== "text") throw new Error("expected text");
    expect(section.body.text).toContain(
      "of the Deployments and StatefulSets this app watches here"
    );
    const whole = { from, seenAt: to, to: null, kinds };
    const all = watchedSection(whole, [whole], [], t, "all");
    expect(all.body.type === "text" && all.body.text).toContain(
      "of the Deployments, StatefulSets, and DaemonSets this app watches here"
    );
  });

  it("prints when watching started in UTC", () => {
    const span = { from, seenAt: to, to: null };
    const section = watchedSection(span, [span], [], t, "all");
    if (section.body.type !== "text") throw new Error("expected text");
    expect(section.body.text).toMatch(/\b0?3:07\b.* UTC/);
  });

  /**
   * The 24h / 7d toggle is the screen's own state, in neither the address
   * nor the rows: the file listed changes with no word of how far back it
   * looked. Fails if the section stops saying its window.
   */
  it("says how far back the screen was looking", () => {
    expect(changesScreenSection([], t, "7d").caption).toBe(
      "What changed in the last 7d."
    );
  });
});

describe("rows no read placed, in the shared Changes report", () => {
  /** Fails if a change or an event no read placed reaches the file without saying it may be another cluster's, or a placed one says it. */
  it("says it of each row no read placed, a change and an event alike", () => {
    const row = {
      id: "r",
      seq: 1,
      at: to,
      kind: "Pod",
      group: "",
      namespace: "shop",
      name: "api-1",
      what: { says: "created" as const },
      atRelist: false,
    };
    const event = {
      name: "api-1.1",
      namespace: "shop",
      uid: "e",
      type: "Warning",
      reason: "BackOff",
      message: null,
      source: null,
      involvedObject: {
        kind: "Pod",
        name: "api-1",
        namespace: "shop",
        uid: null,
      },
      count: 1,
      firstTimestamp: null,
      lastTimestamp: null,
    };
    const section = changesScreenSection(
      [
        { kind: "journal", unplaced: true, at: to, row },
        { kind: "event", unplaced: true, at: to - 1, row, event },
        { kind: "journal", unplaced: false, at: to - 2, row },
      ],
      t,
      "24h"
    );
    const rows = section.body.type === "changes" ? section.body.changes : [];
    expect(
      rows.map((change) =>
        change.parts.some((part) =>
          part.text.startsWith("Recorded under this name while")
        )
      )
    ).toEqual([true, true, false]);
  });
});

describe("what the shared Changes report says beyond the changes", () => {
  /** An event is the cluster's words, with its object and its count. Fails if a series loses either in the file. */
  it("carries an event with its object and its count", () => {
    const section = changesScreenSection(
      [
        {
          kind: "event",
          unplaced: false,
          at: to,
          row: {
            id: "e",
            seq: 1,
            at: to,
            kind: "Pod",
            group: "",
            namespace: "shop",
            name: "api-1",
            what: { says: "created" },
            atRelist: false,
          },
          event: {
            name: "api-1.1",
            namespace: "shop",
            uid: "e",
            type: "Warning",
            reason: "BackOff",
            message: "Back-off restarting failed container",
            source: null,
            involvedObject: {
              kind: "Pod",
              name: "api-1",
              namespace: "shop",
              uid: null,
            },
            count: 3,
            firstTimestamp: null,
            lastTimestamp: null,
          },
        },
      ],
      t,
      "24h",
      "warnings"
    );
    if (section.body.type !== "changes") throw new Error("expected changes");
    expect(section.body.changes[0]).toMatchObject({
      ref: { kind: "Pod" },
      parts: [
        { text: "Warning · BackOff · Back-off restarting failed container ×3" },
      ],
    });
    expect(section.caption).toBe(
      "What changed in the last 24h. · Warnings only"
    );
    expect(section.count).toBe(1);
  });

  /** A machine with no data folder keeps nothing: fails if the file reads as kept, or does not warn. */
  it("says the timeline is not kept where there is nowhere to keep it, as a warning", () => {
    const span = { from, seenAt: to, to: null };
    const section = watchedSection(span, [span], [], t, "all", {
      read: true,
      keeping: { says: "nowhere" },
      identity: undefined,
      unreadable: 0,
      error: null,
      letGo: undefined,
      readFrom: null,
    });
    if (section.body.type !== "text") throw new Error("expected text");
    expect(section.body.text).toContain(
      "Kept for this session only: this machine has no data folder to keep it in."
    );
    expect(section.body.role).toBe("warn");
  });

  /** A session-only timeline is not one that was kept: fails if the file says nothing of it, or does not warn. */
  it("says the timeline was kept for this session only, as a warning", () => {
    const span = { from, seenAt: to, to: null };
    const section = watchedSection(span, [span], [], t, "all", {
      read: true,
      keeping: { says: "off" },
      identity: undefined,
      unreadable: 0,
      error: null,
      letGo: undefined,
      readFrom: null,
    });
    if (section.body.type !== "text") throw new Error("expected text");
    expect(section.body.text).toContain(
      "Kept for this session only: keeping between restarts is off in Settings."
    );
    expect(section.body.role).toBe("warn");
  });

  /**
   * A busy cluster's first page is five hundred events, and the edit made
   * before them is below the rows read. Fails if the file calls the watch
   * quiet over rows nobody read.
   */
  it("calls no watch quiet over rows not read yet", () => {
    const span = { from, seenAt: to, to: null };
    const read = (readFrom: number | null) => ({
      read: true,
      keeping: { says: "kept" as const },
      identity: undefined,
      unreadable: 0,
      error: null,
      letGo: undefined,
      readFrom,
    });
    const unread = watchedSection(
      span,
      [span],
      [],
      t,
      "all",
      read(from + 60_000)
    );
    expect(unread.body.type === "text" && unread.body.text).not.toContain(
      "No change recorded"
    );
    const whole = watchedSection(span, [span], [], t, "all", read(null));
    expect(whole.body.type === "text" && whole.body.text).toContain(
      "No change recorded"
    );
  });

  /**
   * kind made again under the same name, opened by someone who may not read
   * kube-system: the rows kept from before may be the old cluster's. Fails if
   * the file says nothing of it.
   */
  it("says the kept rows may be another cluster's where which cluster this is could not be checked", () => {
    const span = { from, seenAt: to, to: null };
    const section = watchedSection(span, [span], [], t, "all", {
      read: true,
      keeping: { says: "kept" },
      identity: { says: "unknown", message: "namespaces is forbidden" },
      unreadable: 0,
      error: null,
      letGo: undefined,
      readFrom: null,
    });
    expect(section.body.type === "text" && section.body.text).toContain(
      "Rows kept under this name may be another cluster's that had it: which cluster this is could not be checked (namespaces is forbidden)."
    );
  });

  /**
   * The connection changed each time which cluster this is was read: the
   * rows held were still filed as this cluster's. Fails if the file does
   * not say they may be another's.
   */
  it("says the kept rows may be another cluster's where which cluster this is could not be settled", () => {
    const span = { from, seenAt: to, to: null };
    const section = watchedSection(span, [span], [], t, "all", {
      read: true,
      keeping: { says: "kept" },
      identity: { says: "unsettled" },
      unreadable: 0,
      error: null,
      letGo: undefined,
      readFrom: null,
    });
    expect(section.body.type === "text" && section.body.text).toContain(
      "the connection changed each time which cluster this is was checked."
    );
  });

  /**
   * Under "Warnings only" the screen reads no change row at all, while forty
   * Deployment edits sat in the timeline. Fails if the file sent on says none
   * was made.
   */
  it("calls no watch quiet from a screen that read warnings only", () => {
    const span = { from, seenAt: to, to: null };
    const section = watchedSection(span, [span], [], t, "warnings");
    expect(section.body.type === "text" && section.body.text).not.toContain(
      "No change recorded"
    );
  });
});
