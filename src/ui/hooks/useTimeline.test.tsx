import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type {
  TimelinePage,
  TimelineQuery,
  TimelineRow,
} from "@/generated/types";
import { forgetChannels } from "@/lib/events";
import { useClusterStore } from "@/stores/clusterStore";
import {
  forgetOldJournal,
  useTimeline,
  useTimelineFollow,
  useTimelineHold,
  withNewer,
} from "./useTimeline";
import { persistedByName } from "@/lib/kept-by-name";

const row = (id: string, at: number, seq = at): TimelineRow => ({
  id,
  seq,
  at,
  kind: "Deployment",
  group: "apps",
  namespace: "shop",
  name: "api",
  what: { says: "created" },
  atRelist: false,
});

describe("rows laid into the ones held", () => {
  /** Fails if a repeat of a series is drawn twice, or a row arrives out of order. */
  it("moves a repeated series to its new place and keeps the rest in order", () => {
    const held = [row("c", 30), row("b", 20), row("a", 10)];
    const merged = withNewer(held, [row("a", 40, 41), row("d", 25)]);
    expect(merged.map((each) => each.id)).toEqual(["a", "c", "d", "b"]);
  });

  /** Fails if a row nothing changed is rebuilt, which redraws every row on screen. */
  it("keeps the identity of every row nothing changed", () => {
    const held = [row("b", 20), row("a", 10)];
    const merged = withNewer(held, [row("c", 30)]);
    expect(merged[1]).toBe(held[0]);
    expect(merged[2]).toBe(held[1]);
  });
});

function page(
  rows: TimelineRow[],
  over: Partial<TimelinePage> = {}
): TimelinePage {
  return {
    rows,
    more: false,
    newest: Math.max(0, ...rows.map((each) => each.seq)),
    spans: { followed: [], meta: [] },
    letGo: { changes: null, warnings: null, normal: null },
    keeping: { says: "kept" },
    identity: { says: "known" },
    vouched: [{ first: 0, last: null }],
    epoch: 0,
    unreadable: 0,
    ...over,
  };
}

/** A window wide enough that rows dated near 1970 stay in it. */
const WIDE = 1e15;

describe("one surface reading the timeline", () => {
  let announce: ((event: { payload: unknown }) => void) | null = null;
  let asked: TimelineQuery[] = [];
  let answers: (TimelinePage | Promise<TimelinePage> | Error)[] = [];
  /** What the backend's rows are numbered under when nothing else is queued. */
  let epochNow = 0;
  const fresh = () =>
    new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapperOf =
    (client: QueryClient) =>
    ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  const told = (context: string) =>
    act(() =>
      announce?.({
        payload: {
          channel: "timeline-changed",
          context,
          rows: true,
          spans: false,
        },
      })
    );
  /** The first page and the catch-up made once it is held. */
  const settled = () =>
    waitFor(() => expect(asked.length).toBeGreaterThanOrEqual(2));

  beforeEach(() => {
    forgetChannels();
    announce = null;
    asked = [];
    answers = [];
    epochNow = 0;
    useClusterStore.setState({ currentContext: "prod", isConnected: true });
    vi.mocked(listen).mockImplementation(async (event, handler) => {
      if (event === "timeline-changed") announce = handler as typeof announce;
      return () => {};
    });
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command !== "timeline_read") return undefined;
      asked.push((args as { query: TimelineQuery }).query);
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return next ?? page([], { epoch: epochNow });
    });
  });

  /**
   * Work is the size of the change: a busy cluster told the window a row
   * arrived once a second. Fails if the window reads the whole timeline
   * again rather than what was recorded since what it holds, or reads
   * another cluster's news.
   */
  it("reads only what was recorded since the newest row it holds", async () => {
    answers = [page([row("b", 20), row("a", 10)])];
    const { result } = renderHook(
      () => useTimeline({ windowMs: WIDE, show: "all" }),
      { wrapper: wrapperOf(fresh()) }
    );
    await waitFor(() => expect(result.current.rows).toHaveLength(2));
    await settled();
    told("staging");
    expect(asked).toHaveLength(2);
    answers = [page([row("c", 30)], { newest: 30 })];
    told("prod");
    await waitFor(() => expect(result.current.rows).toHaveLength(3));
    expect(asked[2].after).toBe(20);
    expect(result.current.rows.map((each) => each.id)).toEqual(["c", "b", "a"]);
  });

  /** More arrived than one answer holds: fails if the window lays a part of it in as if it were all. */
  it("reads the whole first page again when more arrived than one answer holds", async () => {
    answers = [page([row("a", 10)])];
    const { result } = renderHook(
      () => useTimeline({ windowMs: WIDE, show: "all" }),
      { wrapper: wrapperOf(fresh()) }
    );
    await waitFor(() => expect(result.current.rows).toHaveLength(1));
    await settled();
    answers = [
      page([row("z", 90)], { more: true }),
      page([row("z", 90), row("y", 80), row("a", 10)]),
    ];
    told("prod");
    await waitFor(() => expect(result.current.rows).toHaveLength(3));
    expect(asked[3].after).toBeNull();
  });

  /** Older rows not read yet are said to be: fails if the last row read is drawn as the end of the window. */
  it("says where the rows read end while older ones remain, and reads them on asking", async () => {
    answers = [page([row("b", 20), row("a", 10)], { more: true })];
    const { result } = renderHook(
      () => useTimeline({ windowMs: WIDE, show: "all" }),
      { wrapper: wrapperOf(fresh()) }
    );
    await waitFor(() => expect(result.current.readFrom).toBe(10));
    await settled();
    answers = [page([row("x", 5)])];
    act(() => result.current.loadOlder());
    await waitFor(() => expect(result.current.rows).toHaveLength(3));
    expect(asked[2].before).toEqual({ at: 10, seq: 10 });
    expect(result.current.readFrom).toBeNull();
  });

  /**
   * A relist records every live event again under a new number and its old
   * time. Fails if one older than the last row read becomes the tail: the
   * next page would start below it, past changes nobody read, and the page
   * would draw that stretch as read.
   */
  it("leaves a row recorded since but older than what was read for the page that reads there", async () => {
    answers = [page([row("b", 20), row("a", 10)], { more: true })];
    const { result } = renderHook(
      () => useTimeline({ windowMs: WIDE, show: "all" }),
      { wrapper: wrapperOf(fresh()) }
    );
    await waitFor(() => expect(result.current.readFrom).toBe(10));
    await settled();
    answers = [page([row("c", 30), row("old-event", 5, 31)])];
    told("prod");
    await waitFor(() => expect(result.current.rows).toHaveLength(3));
    expect(result.current.rows.map((each) => each.id)).toEqual(["c", "b", "a"]);
    expect(result.current.readFrom).toBe(10);
    answers = [page([row("x", 8), row("old-event", 5, 31)])];
    act(() => result.current.loadOlder());
    await waitFor(() => expect(result.current.rows).toHaveLength(5));
    expect(asked[3].before).toEqual({ at: 10, seq: 10 });
  });

  /**
   * An older page answered after the backend started over, for another
   * cluster under the name: laid in, the old cluster's rows sat below the
   * new one's. Fails if that page is laid in rather than the timeline read
   * again from the top.
   */
  it("reads the timeline again from the top when an older page comes from rows that started over", async () => {
    answers = [page([row("b", 20), row("a", 10)], { more: true })];
    const { result } = renderHook(
      () => useTimeline({ windowMs: WIDE, show: "all" }),
      { wrapper: wrapperOf(fresh()) }
    );
    await waitFor(() => expect(result.current.readFrom).toBe(10));
    await settled();
    epochNow = 1;
    answers = [
      page([row("x", 5)], { epoch: 1 }),
      page([row("new", 30, 3)], { epoch: 1 }),
    ];
    act(() => result.current.loadOlder());
    await waitFor(() =>
      expect(result.current.rows.map((each) => each.id)).toEqual(["new"])
    );
  });

  /**
   * An older page asked before the backend started over came back after
   * the window had read the new cluster's rows, numbered from the start so
   * its last row matched. Fails if the old cluster's page is laid in below
   * the new cluster's rows.
   */
  it("lays in no answer asked of rows that have since started over", async () => {
    answers = [page([row("b", 20), row("a", 10)], { more: true })];
    const { result } = renderHook(
      () => useTimeline({ windowMs: WIDE, show: "all" }),
      { wrapper: wrapperOf(fresh()) }
    );
    await waitFor(() => expect(result.current.readFrom).toBe(10));
    await settled();
    let older: (page: TimelinePage) => void = () => {};
    answers = [new Promise((resolve) => (older = resolve))];
    act(() => result.current.loadOlder());
    epochNow = 1;
    answers = [
      page([], { epoch: 1, newest: 10 }),
      page([row("new", 10, 10)], { epoch: 1, more: true }),
    ];
    told("prod");
    await waitFor(() =>
      expect(result.current.rows.map((each) => each.id)).toEqual(["new"])
    );
    await act(async () => {
      older(page([row("old", 5)]));
      await new Promise((settle) => setTimeout(settle, 50));
    });
    expect(result.current.rows.map((each) => each.id)).toEqual(["new"]);
  });

  /**
   * A catch-up asked of the old rows came back after an older page had found
   * them started over and read the new ones: laid in, it brought the old
   * cluster's row back and its numbering with it. Fails if a catch-up's
   * answer is laid into rows of another numbering.
   */
  it("lays in no catch-up answered after the rows started over", async () => {
    answers = [page([row("b", 20), row("a", 10)], { more: true })];
    const { result } = renderHook(
      () => useTimeline({ windowMs: WIDE, show: "all" }),
      { wrapper: wrapperOf(fresh()) }
    );
    await waitFor(() => expect(result.current.readFrom).toBe(10));
    await settled();
    let late: (page: TimelinePage) => void = () => {};
    answers = [new Promise((resolve) => (late = resolve))];
    told("prod");
    await waitFor(() => expect(asked).toHaveLength(3));
    epochNow = 1;
    answers = [
      page([row("x", 5)], { epoch: 1 }),
      page([row("new", 30, 3)], { epoch: 1 }),
    ];
    act(() => result.current.loadOlder());
    await waitFor(() =>
      expect(result.current.rows.map((each) => each.id)).toEqual(["new"])
    );
    await act(async () => {
      late(page([row("old", 40, 99)], { newest: 99 }));
      await new Promise((settle) => setTimeout(settle, 50));
    });
    expect(result.current.rows.map((each) => each.id)).toEqual(["new"]);
  });

  /**
   * A window switched away and back while its catch-up was out: the one
   * opened again found the rows started over and read the new ones, then
   * the first catch-up's answer reset them again. Fails if an answer asked
   * of rows read again since drops what was read.
   */
  it("keeps the rows read again when an earlier catch-up finds them started over", async () => {
    answers = [page([row("a", 10)])];
    const { result, rerender } = renderHook(
      ({ windowMs }) => useTimeline({ windowMs, show: "all" }),
      { wrapper: wrapperOf(fresh()), initialProps: { windowMs: WIDE } }
    );
    await waitFor(() => expect(result.current.rows).toHaveLength(1));
    await settled();
    let late: (page: TimelinePage) => void = () => {};
    answers = [new Promise((resolve) => (late = resolve))];
    told("prod");
    await waitFor(() => expect(asked).toHaveLength(3));
    rerender({ windowMs: WIDE - 1 });
    await waitFor(() => expect(asked).toHaveLength(5));
    epochNow = 1;
    answers = [page([], { epoch: 1 }), page([row("new", 30, 3)], { epoch: 1 })];
    rerender({ windowMs: WIDE });
    await waitFor(() =>
      expect(result.current.rows.map((each) => each.id)).toEqual(["new"])
    );
    await act(async () => {
      late(page([], { epoch: 1 }));
      await new Promise((settle) => setTimeout(settle, 50));
    });
    expect(result.current.rows.map((each) => each.id)).toEqual(["new"]);
  });

  /**
   * An older page asked of the old rows answered from the new numbering
   * after a catch-up had read the new rows: it reset them again. Fails if
   * that answer drops the rows read since.
   */
  it("keeps the rows read again when an older page finds them started over", async () => {
    answers = [page([row("b", 20), row("a", 10)], { more: true })];
    const { result } = renderHook(
      () => useTimeline({ windowMs: WIDE, show: "all" }),
      { wrapper: wrapperOf(fresh()) }
    );
    await waitFor(() => expect(result.current.readFrom).toBe(10));
    await settled();
    let older: (page: TimelinePage) => void = () => {};
    answers = [new Promise((resolve) => (older = resolve))];
    act(() => result.current.loadOlder());
    epochNow = 1;
    answers = [
      page([], { epoch: 1, newest: 10 }),
      page([row("new", 10, 10)], { epoch: 1, more: true }),
    ];
    told("prod");
    await waitFor(() =>
      expect(result.current.rows.map((each) => each.id)).toEqual(["new"])
    );
    await act(async () => {
      older(page([row("x", 5)], { epoch: 1 }));
      await new Promise((settle) => setTimeout(settle, 50));
    });
    expect(result.current.rows.map((each) => each.id)).toEqual(["new"]);
  });

  /**
   * An older page asked at the first numbering came back from a third while
   * the rows held were of the second: nothing read the timeline again, and
   * rows of a numbering the backend had left, a cleared one or another
   * cluster's, stayed on screen. Fails if an answer from a later numbering
   * than the rows held does not read them again.
   */
  it("reads again rows held of a numbering older than an answer's", async () => {
    answers = [page([row("b", 20), row("a", 10)], { more: true })];
    const { result } = renderHook(
      () => useTimeline({ windowMs: WIDE, show: "all" }),
      { wrapper: wrapperOf(fresh()) }
    );
    await waitFor(() => expect(result.current.readFrom).toBe(10));
    await settled();
    let older: (page: TimelinePage) => void = () => {};
    answers = [new Promise((resolve) => (older = resolve))];
    act(() => result.current.loadOlder());
    epochNow = 1;
    answers = [
      page([], { epoch: 1, newest: 10 }),
      page([row("one", 30, 3)], { epoch: 1 }),
    ];
    told("prod");
    await waitFor(() =>
      expect(result.current.rows.map((each) => each.id)).toEqual(["one"])
    );
    epochNow = 2;
    answers = [page([row("two", 40, 1)], { epoch: 2 })];
    act(() => older(page([row("x", 5)], { epoch: 2 })));
    await waitFor(() =>
      expect(result.current.rows.map((each) => each.id)).toEqual(["two"])
    );
  });

  /**
   * A catch-up that failed was swallowed: the rows held stayed, and the
   * page went on calling the stretch since quiet. Fails if a failed
   * catch-up is not the read's error until one answers again.
   */
  it("says a catch-up that failed, until one answers", async () => {
    answers = [page([row("a", 10)])];
    const { result } = renderHook(
      () => useTimeline({ windowMs: WIDE, show: "all" }),
      { wrapper: wrapperOf(fresh()) }
    );
    await waitFor(() => expect(result.current.rows).toHaveLength(1));
    await settled();
    answers = [new Error("disk refused")];
    told("prod");
    await waitFor(() =>
      expect(result.current.error?.message).toContain("disk refused")
    );
    expect(result.current.rows).toHaveLength(1);
    told("prod");
    await waitFor(() => expect(result.current.error).toBeNull());
  });

  /**
   * A catch-up of the 24-hour window was out when the reader switched to 7
   * days, whose catch-up failed; the first one's late success cleared that
   * failure, and the stretch it never read was called quiet again. Fails if
   * an answer to a question no longer asked writes the read's error.
   */
  it("keeps the failure of the question asked now when an earlier one answers late", async () => {
    answers = [page([row("a", 10)])];
    const { result, rerender } = renderHook(
      ({ windowMs }) => useTimeline({ windowMs, show: "all" }),
      { wrapper: wrapperOf(fresh()), initialProps: { windowMs: WIDE } }
    );
    await waitFor(() => expect(result.current.rows).toHaveLength(1));
    await settled();
    let late: (page: TimelinePage) => void = () => {};
    answers = [new Promise((resolve) => (late = resolve))];
    told("prod");
    await waitFor(() => expect(asked).toHaveLength(3));
    answers = [page([row("a", 10)]), new Error("disk refused")];
    rerender({ windowMs: WIDE - 1 });
    await waitFor(() =>
      expect(result.current.error?.message).toContain("disk refused")
    );
    await act(async () => {
      late(page([]));
      await new Promise((settle) => setTimeout(settle, 50));
    });
    expect(result.current.error?.message).toContain("disk refused");
  });

  /**
   * A Changes tab closed and opened again within the cache's life: its rows
   * were held and never read again, so what was recorded while it was closed
   * stayed off screen until the next change. Fails if a surface opened on
   * held rows does not catch up.
   */
  it("catches up rows recorded while it was closed, once it listens again", async () => {
    const client = fresh();
    answers = [page([row("b", 20), row("a", 10)])];
    const first = renderHook(
      () => useTimeline({ windowMs: WIDE, show: "all" }),
      { wrapper: wrapperOf(client) }
    );
    await waitFor(() => expect(first.result.current.rows).toHaveLength(2));
    await settled();
    first.unmount();
    answers = [page([row("c", 30)], { newest: 30 })];
    const again = renderHook(
      () => useTimeline({ windowMs: WIDE, show: "all" }),
      { wrapper: wrapperOf(client) }
    );
    await waitFor(() =>
      expect(again.result.current.rows.map((each) => each.id)).toEqual([
        "c",
        "b",
        "a",
      ])
    );
  });

  /**
   * A row recorded while the first page was on its way: the news came
   * before there was anything held to catch up from. Fails if that row
   * stays off screen until the next change.
   */
  it("catches up a news that came before the first page was held", async () => {
    let answer: (page: TimelinePage) => void = () => {};
    answers = [new Promise((resolve) => (answer = resolve))];
    const { result } = renderHook(
      () => useTimeline({ windowMs: WIDE, show: "all" }),
      { wrapper: wrapperOf(fresh()) }
    );
    await waitFor(() => expect(asked).toHaveLength(1));
    told("prod");
    answers = [page([row("c", 30)], { newest: 30 })];
    act(() => answer(page([row("a", 10)])));
    await waitFor(() =>
      expect(result.current.rows.map((each) => each.id)).toEqual(["c", "a"])
    );
  });

  /**
   * Two surfaces of one key, their catch-ups answered out of order: the
   * older answer replaced the newer version of a series and lowered what was
   * read up to. Fails if a late answer undoes a later one.
   */
  it("keeps the later version of a series over one that arrives after it", () => {
    const held = [row("e", 40, 22), row("a", 10)];
    expect(withNewer(held, [row("e", 30, 21)])).toEqual(held);
    expect(withNewer(held, [row("e", 50, 23)]).map((each) => each.seq)).toEqual(
      [23, 10]
    );
  });

  /**
   * A page left open for days kept every row it was ever told of, long
   * after they left its window. Fails if a catch-up keeps rows older than
   * the window.
   */
  it("lets go of rows that left the window as it catches up", async () => {
    const now = Date.now();
    answers = [page([row("old", now - 70_000, 1)])];
    const { result } = renderHook(
      () => useTimeline({ windowMs: 60_000, show: "all" }),
      { wrapper: wrapperOf(fresh()) }
    );
    await waitFor(() => expect(asked.length).toBeGreaterThanOrEqual(1));
    answers = [page([row("new", now, 2)], { newest: 2 })];
    told("prod");
    await waitFor(() =>
      expect(result.current.rows.map((each) => each.id)).toEqual(["new"])
    );
  });

  /**
   * A series a catch-up moved to the top while an older page was read came
   * back in that page in its old place. Fails if one series is drawn twice.
   */
  it("does not lay in a series an older page holds once more", async () => {
    answers = [page([row("b", 20), row("a", 10)], { more: true })];
    const { result } = renderHook(
      () => useTimeline({ windowMs: WIDE, show: "all" }),
      { wrapper: wrapperOf(fresh()) }
    );
    await waitFor(() => expect(result.current.readFrom).toBe(10));
    await settled();
    answers = [page([row("a", 40, 31)], { newest: 31 })];
    told("prod");
    await waitFor(() =>
      expect(result.current.rows.map((each) => each.id)).toEqual(["a", "b"])
    );
    answers = [page([row("a", 10), row("x", 5)])];
    act(() => result.current.loadOlder());
    await waitFor(() => expect(result.current.rows).toHaveLength(3));
    expect(result.current.rows.map((each) => each.id)).toEqual(["a", "b", "x"]);
  });

  /**
   * A DaemonSet's tab named no group, which the backend reads as any: a
   * custom DaemonSet of the same name filled the built-in's history. Fails
   * if a subject without a group is not asked for in its built-in group, or
   * a custom kind loses its own.
   */
  it("asks for a built-in kind in its own group where the page names none", async () => {
    renderHook(
      () =>
        useTimeline({
          subject: {
            kind: "DaemonSet",
            group: null,
            namespace: "kube-system",
            name: "agent",
          },
          windowMs: WIDE,
          show: "all",
        }),
      { wrapper: wrapperOf(fresh()) }
    );
    await waitFor(() => expect(asked.length).toBeGreaterThanOrEqual(1));
    expect(asked[0].subject?.group).toBe("apps");
    renderHook(
      () =>
        useTimeline({
          subject: {
            kind: "DaemonSet",
            group: "apps.kruise.io",
            namespace: "kube-system",
            name: "agent",
          },
          windowMs: WIDE,
          show: "all",
        }),
      { wrapper: wrapperOf(fresh()) }
    );
    await waitFor(() =>
      expect(
        asked.some((each) => each.subject?.group === "apps.kruise.io")
      ).toBe(true)
    );
  });
});

describe("rows that started over", () => {
  let announce: ((event: { payload: unknown }) => void) | null = null;
  let answers: TimelinePage[] = [];
  let reads = 0;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      {children}
    </QueryClientProvider>
  );

  beforeEach(() => {
    forgetChannels();
    useClusterStore.setState({
      currentContext: "kind-kind",
      isConnected: true,
    });
    vi.mocked(listen).mockImplementation(async (event, handler) => {
      if (event === "timeline-changed") announce = handler as typeof announce;
      return () => {};
    });
    reads = 0;
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command !== "timeline_read") return undefined;
      reads += 1;
      return answers.shift() ?? page([]);
    });
  });

  /**
   * kind was made again under the same name while the page was open: the
   * backend started over, numbering from 1, and the page asked for rows after
   * the old cluster's newest. Fails if the old cluster's rows stay on screen,
   * or the new cluster's first rows are never read.
   */
  it("reads the timeline again from the top once the backend started over", async () => {
    answers = [page([row("old-b", 800), row("old-a", 700)])];
    const { result } = renderHook(
      () => useTimeline({ windowMs: WIDE, show: "all" }),
      { wrapper }
    );
    await waitFor(() => expect(result.current.rows).toHaveLength(2));
    await waitFor(() => expect(reads).toBeGreaterThanOrEqual(2));
    answers = [
      page([], { epoch: 1, newest: 3 }),
      page([row("new-c", 30, 3), row("new-b", 20, 2), row("new-a", 10, 1)], {
        epoch: 1,
      }),
    ];
    act(() =>
      announce?.({
        payload: {
          channel: "timeline-changed",
          context: "kind-kind",
          rows: true,
          spans: true,
        },
      })
    );
    await waitFor(() =>
      expect(result.current.rows.map((each) => each.id)).toEqual([
        "new-c",
        "new-b",
        "new-a",
      ])
    );
  });
});

describe("the 5.0 journal", () => {
  /** Fails if the journal 5.0 kept in the window's storage stays there once nothing reads it. */
  it("is forgotten on start", () => {
    localStorage.setItem("change-journal", "{}");
    forgetOldJournal();
    expect(localStorage.getItem("change-journal")).toBeNull();
  });
});

describe("a timeline on screen", () => {
  /** Fails if a surface does not tell the backend it is on screen, or names another cluster. */
  it("tells the backend which cluster it is on screen for", async () => {
    useClusterStore.setState({ currentContext: "prod", isConnected: true });
    const held: unknown[] = [];
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "timeline_hold") held.push(args);
      return true;
    });
    renderHook(() => useTimelineHold(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={new QueryClient()}>
          {children}
        </QueryClientProvider>
      ),
    });
    await waitFor(() => expect(held).toEqual([{ scope: null }]));
  });
});

describe("the cluster on screen", () => {
  /**
   * The timeline records the cluster on screen, in the window's namespaces
   * where the cluster refuses a kind across it. Fails if a connect is not
   * followed, the namespaces are not passed, or another cluster found under
   * the name keeps what was persisted for the old one.
   */
  it("is followed on connect and in the window's namespaces, and another cluster under the name is let go of", async () => {
    useClusterStore.setState({
      currentContext: "prod",
      isConnected: true,
      namespaceScope: ["shop"],
    });
    const asked: unknown[] = [];
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command !== "timeline_follow") return undefined;
      asked.push(args);
      return { anotherCluster: true };
    });
    const forgotten: string[] = [];
    const off = persistedByName((context) => forgotten.push(context));
    renderHook(() => useTimelineFollow());
    await waitFor(() => expect(forgotten).toEqual(["prod"]));
    expect(asked).toEqual([{ scope: ["shop"] }]);
    off();
  });
});
