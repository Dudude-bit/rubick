import { beforeEach, describe, expect, it } from "vitest";

import { gapsOf } from "@/lib/changes";
import {
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
  useChangeJournalStore.setState({ entries: [], spans: {} });
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
    store.heartbeat("dev", T0 + 30 * MINUTE);
    store.heartbeat("dev", T0 + 130 * MINUTE);
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
