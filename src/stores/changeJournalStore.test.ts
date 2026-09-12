import { beforeEach, describe, expect, it } from "vitest";

import { gapsOf } from "@/lib/changes";
import {
  HEARTBEAT_MS,
  JOURNAL_TTL_MS,
  MAX_JOURNAL_ENTRIES,
  useChangeJournalStore,
} from "./changeJournalStore";

const T0 = Date.parse("2026-09-08T00:00:00Z");
const MINUTE = 60_000;

const entry = (at: number, name = "api") => ({
  id: `e-${at}-${name}`,
  context: "dev",
  kind: "Deployment",
  namespace: "shop",
  name,
  at,
  field: "replicas" as const,
  key: null,
  from: "1",
  to: "2",
});

beforeEach(() => {
  useChangeJournalStore.setState({ entries: [], spans: {}, identities: {} });
});

describe("which cluster a context name turned out to be", () => {
  /**
   * A `kind` cluster torn down and rebuilt keeps its context name. Left
   * alone, the page draws the hours the old cluster was watched as hours
   * this one was.
   */
  it("drops what was recorded when the context names a different cluster", () => {
    const store = useChangeJournalStore.getState();
    store.seenCluster("dev", "uid-1");
    store.record([entry(T0)]);
    store.beginSpan("dev", T0);
    useChangeJournalStore.getState().seenCluster("dev", "uid-2");
    const state = useChangeJournalStore.getState();
    expect(state.entries).toEqual([]);
    expect(state.spans.dev).toBeUndefined();
    expect(state.identities.dev).toBe("uid-2");
  });

  /**
   * A reader who may not read `kube-system` learns nothing about which
   * cluster this is, and "could not tell" must not act like "another one".
   */
  it("drops nothing when the cluster could not be identified", () => {
    const store = useChangeJournalStore.getState();
    store.seenCluster("dev", "uid-1");
    store.record([entry(T0)]);
    useChangeJournalStore.getState().seenCluster("dev", null);
    const state = useChangeJournalStore.getState();
    expect(state.entries).toHaveLength(1);
    expect(state.identities.dev).toBe("uid-1");
  });

  it("keeps what it has the first time it learns the cluster", () => {
    const store = useChangeJournalStore.getState();
    store.record([entry(T0)]);
    store.seenCluster("dev", "uid-1");
    expect(useChangeJournalStore.getState().entries).toHaveLength(1);
  });
});

describe("spans", () => {
  /**
   * The app crashed at 02:10 and came back at 07:40. Nothing wrote the end
   * of the span; the heartbeat is what says when it was last alive, and
   * the gap is measured from there rather than from the restart.
   */
  it("ends a span left open at its last heartbeat, so the gap starts there", () => {
    const store = useChangeJournalStore.getState();
    store.beginSpan("dev", T0);
    for (let tick = 1; tick <= (130 * MINUTE) / HEARTBEAT_MS; tick += 1)
      store.heartbeat("dev", T0 + tick * HEARTBEAT_MS);
    // A restart: the store rehydrates and closes what was open.
    const persisted = useChangeJournalStore.getState().spans;
    const reopened = useChangeJournalStore.persist.getOptions().merge!(
      { entries: [], spans: persisted },
      useChangeJournalStore.getState()
    );
    expect(reopened.spans.dev[0]).toEqual({
      from: T0,
      seenAt: T0 + 130 * MINUTE,
      to: T0 + 130 * MINUTE,
    });
    expect(gapsOf(reopened.spans.dev, T0, T0 + 460 * MINUTE)).toEqual([
      { from: T0 + 130 * MINUTE, to: T0 + 460 * MINUTE },
    ]);
  });

  /**
   * The timer does not run while the machine sleeps or the tab is frozen.
   * Taking the late tick as proof the watch was alive the whole time draws a
   * night nobody watched as a quiet cluster.
   */
  it("breaks the span where a heartbeat did not arrive on time", () => {
    const store = useChangeJournalStore.getState();
    store.beginSpan("dev", T0);
    store.heartbeat("dev", T0 + HEARTBEAT_MS);
    store.heartbeat("dev", T0 + 8 * 60 * MINUTE);
    const spans = useChangeJournalStore.getState().spans.dev;
    expect(spans).toEqual([
      { from: T0, seenAt: T0 + HEARTBEAT_MS, to: T0 + HEARTBEAT_MS },
      { from: T0 + 8 * 60 * MINUTE, seenAt: T0 + 8 * 60 * MINUTE, to: null },
    ]);
    expect(gapsOf(spans, T0, T0 + 9 * 60 * MINUTE)).toEqual([
      { from: T0 + HEARTBEAT_MS, to: T0 + 8 * 60 * MINUTE },
    ]);
  });

  /** Every connect appends one; a month of them is a list nothing prunes. */
  it("drops spans older than the journal keeps entries for", () => {
    const store = useChangeJournalStore.getState();
    store.beginSpan("dev", T0);
    store.endSpan("dev", T0 + MINUTE);
    store.beginSpan("dev", T0 + JOURNAL_TTL_MS + 2 * MINUTE);
    expect(useChangeJournalStore.getState().spans.dev).toHaveLength(1);
  });

  it("closes the previous span when a new one begins", () => {
    const store = useChangeJournalStore.getState();
    store.beginSpan("dev", T0);
    store.heartbeat("dev", T0 + MINUTE);
    store.beginSpan("dev", T0 + 10 * MINUTE);
    const spans = useChangeJournalStore.getState().spans.dev;
    expect(spans.map((s) => s.to)).toEqual([T0 + MINUTE, null]);
  });

  it("keeps clusters apart", () => {
    const store = useChangeJournalStore.getState();
    store.beginSpan("dev", T0);
    store.beginSpan("prod", T0);
    store.endSpan("dev", T0 + MINUTE);
    const spans = useChangeJournalStore.getState().spans;
    expect(spans.dev[0].to).toBe(T0 + MINUTE);
    expect(spans.prod[0].to).toBeNull();
  });
});

describe("entries", () => {
  it("keeps the newest entries per cluster once past the cap", () => {
    const store = useChangeJournalStore.getState();
    const many = Array.from({ length: MAX_JOURNAL_ENTRIES + 5 }, (_, i) =>
      entry(T0 + i)
    );
    store.record(many);
    const kept = useChangeJournalStore.getState().entries;
    expect(kept).toHaveLength(MAX_JOURNAL_ENTRIES);
    expect(kept[0].at).toBe(T0 + 5);
    expect(kept.at(-1)?.at).toBe(T0 + MAX_JOURNAL_ENTRIES + 4);
  });

  it("forgets one cluster and leaves the other", () => {
    const store = useChangeJournalStore.getState();
    store.record([entry(T0), { ...entry(T0 + 1), context: "prod" }]);
    store.beginSpan("dev", T0);
    store.forget("dev");
    const state = useChangeJournalStore.getState();
    expect(state.entries.map((e) => e.context)).toEqual(["prod"]);
    expect(state.spans.dev).toBeUndefined();
  });
});
