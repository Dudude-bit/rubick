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
    unreadable: 0,
    ...over,
  };
}

describe("one surface reading the timeline", () => {
  let announce: ((event: { payload: unknown }) => void) | null = null;
  let asked: TimelineQuery[] = [];
  let answers: TimelinePage[] = [];
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      {children}
    </QueryClientProvider>
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

  beforeEach(() => {
    forgetChannels();
    announce = null;
    asked = [];
    answers = [];
    useClusterStore.setState({ currentContext: "prod", isConnected: true });
    vi.mocked(listen).mockImplementation(async (event, handler) => {
      if (event === "timeline-changed") announce = handler as typeof announce;
      return () => {};
    });
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command !== "timeline_read") return undefined;
      asked.push((args as { query: TimelineQuery }).query);
      return answers.shift() ?? page([]);
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
      () => useTimeline({ windowMs: 60_000, show: "all" }),
      { wrapper }
    );
    await waitFor(() => expect(result.current.rows).toHaveLength(2));
    told("staging");
    expect(asked).toHaveLength(1);
    answers = [page([row("c", 30)], { newest: 30 })];
    told("prod");
    await waitFor(() => expect(result.current.rows).toHaveLength(3));
    expect(asked[1].after).toBe(20);
    expect(result.current.rows.map((each) => each.id)).toEqual(["c", "b", "a"]);
  });

  /** More arrived than one answer holds: fails if the window lays a part of it in as if it were all. */
  it("reads the whole first page again when more arrived than one answer holds", async () => {
    answers = [page([row("a", 10)])];
    const { result } = renderHook(
      () => useTimeline({ windowMs: 60_000, show: "all" }),
      { wrapper }
    );
    await waitFor(() => expect(result.current.rows).toHaveLength(1));
    answers = [
      page([row("z", 90)], { more: true }),
      page([row("z", 90), row("y", 80), row("a", 10)]),
    ];
    told("prod");
    await waitFor(() => expect(result.current.rows).toHaveLength(3));
    expect(asked[2].after).toBeNull();
  });

  /** Older rows not read yet are said to be: fails if the last row read is drawn as the end of the window. */
  it("says where the rows read end while older ones remain, and reads them on asking", async () => {
    answers = [page([row("b", 20), row("a", 10)], { more: true })];
    const { result } = renderHook(
      () => useTimeline({ windowMs: 60_000, show: "all" }),
      { wrapper }
    );
    await waitFor(() => expect(result.current.readFrom).toBe(10));
    answers = [page([row("x", 5)])];
    act(() => result.current.loadOlder());
    await waitFor(() => expect(result.current.rows).toHaveLength(3));
    expect(asked[1].before).toEqual({ at: 10, seq: 10 });
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
      () => useTimeline({ windowMs: 60_000, show: "all" }),
      { wrapper }
    );
    await waitFor(() => expect(result.current.readFrom).toBe(10));
    answers = [page([row("c", 30), row("old-event", 5, 31)])];
    told("prod");
    await waitFor(() => expect(result.current.rows).toHaveLength(3));
    expect(result.current.rows.map((each) => each.id)).toEqual(["c", "b", "a"]);
    expect(result.current.readFrom).toBe(10);
    answers = [page([row("x", 8), row("old-event", 5, 31)])];
    act(() => result.current.loadOlder());
    await waitFor(() => expect(result.current.rows).toHaveLength(5));
    expect(asked[2].before).toEqual({ at: 10, seq: 10 });
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
