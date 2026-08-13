/**
 * The three promises the backoff is only allowed to exist because of.
 *
 * A screen nobody is looking at costs nothing; a reader who comes back reads
 * the cluster and not a memory of it; and a query that has gone quiet says so
 * instead of sitting under a word that means "as it happens".
 */

import { act, useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/lib/commands", () => ({ commands: {} }));

import { TooltipProvider } from "@/components/ui/tooltip";
import { DataFreshness } from "@/components/ui/realtime";
import { DetailTabs } from "@/components/resources/DetailTabs";
import { viewGlyph, type DetailTab } from "@/components/resources/detail-tab";
import { FileText, LayoutGrid } from "lucide-react";
import { SCOPE_LIMIT } from "@/lib/namespace-scope";
import { BACKOFF, REFRESH_INTERVALS, type RefreshRate } from "@/lib/refresh";
import { useWindowActivity } from "@/lib/window-activity";
import { useClusterStore } from "@/stores/clusterStore";
import { useLiveQueries, useLiveQuery } from "./useLiveQuery";

const RATE = REFRESH_INTERVALS.resourceList;

const client = () =>
  new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });

/** A query whose answer never changes, so its reads can simply be counted. */
function Probe({ answer = "same" }: { answer?: string }) {
  const { data, freshness } = useLiveQuery<string>({
    queryKey: ["probe"],
    queryFn: async () => {
      reads++;
      return answer;
    },
    refresh: "resourceList",
    staleTime: 0,
  });
  return (
    <>
      <span data-testid="data">{data}</span>
      <DataFreshness
        dataUpdatedAt={freshness.dataUpdatedAt}
        slowed={freshness.slowed}
      />
    </>
  );
}

/**
 * The same question asked of several namespaces at once — the shape a scoped
 * overview and a scoped events feed take, and the one whose cost is
 * multiplied by something the reader picked.
 *
 * `onInterval` records every rate the group settles on, including the ones it
 * only holds for a task: a flicker between two intervals is invisible to an
 * assertion made after the dust has settled, and it is the whole bug in the
 * four-part case below.
 */
function Fanout({
  parts = 2,
  moving = false,
  refresh = "resourceList",
  stagger = 0,
  onInterval,
}: {
  parts?: number;
  moving?: boolean;
  refresh?: RefreshRate;
  /**
   * How far apart the parts answer. Zero resolves them in one flush, which is
   * a fan-out no real cluster produces: four IPC responses arrive in four
   * separate tasks, and a rule that counts answers rather than rounds can only
   * be caught in the gaps between them.
   */
  stagger?: number;
  onInterval?: (everyMs: number | false) => void;
}) {
  const names = Array.from({ length: parts }, (_, index) =>
    String.fromCharCode(97 + index)
  );
  const { data, freshness } = useLiveQueries<string>({
    refresh,
    queries: names.map((name, index) => ({
      queryKey: [name],
      queryFn: async () => {
        if (stagger > 0) {
          await new Promise((resolve) => setTimeout(resolve, index * stagger));
        }
        reads++;
        // One part that answers differently every time, for the case where
        // the group must not be allowed to go quiet.
        return moving && name === names[names.length - 1]
          ? String(reads)
          : name;
      },
      staleTime: 0,
    })),
  });
  const { everyMs } = freshness;
  useEffect(() => {
    onInterval?.(everyMs);
  }, [everyMs, onInterval]);
  return (
    <>
      <span data-testid="data">{data.map((part) => part ?? "").join("")}</span>
      <DataFreshness
        dataUpdatedAt={freshness.dataUpdatedAt}
        slowed={freshness.slowed}
      />
    </>
  );
}

let reads = 0;

/** Let a fetch resolve and its render land, without advancing the clock. */
const settle = async () => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
};

const advance = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

const wrap = (ui: React.ReactNode) =>
  render(
    <QueryClientProvider client={client()}>
      <TooltipProvider>{ui}</TooltipProvider>
    </QueryClientProvider>
  );

beforeEach(() => {
  reads = 0;
  vi.useFakeTimers();
  useClusterStore.setState({ isConnected: true });
  useWindowActivity.setState({
    visible: true,
    focused: true,
    interactionAt: 0,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a surface nobody is looking at", () => {
  const tabs = (): DetailTab[] => [
    {
      id: "overview",
      label: "Overview",
      glyph: viewGlyph(LayoutGrid),
      content: <span>overview</span>,
    },
    {
      id: "logs",
      label: "Logs",
      // A surface: Radix force-mounts its panel once it has been opened, so
      // this tab goes on rendering after the reader switches away from it.
      kind: "surface",
      glyph: viewGlyph(FileText),
      content: <Probe />,
    },
  ];

  it("stops re-reading when its tab is switched away from", async () => {
    const { rerender } = wrap(
      <DetailTabs tabs={tabs()} activeTab="logs" onTabChange={() => {}} />
    );
    await settle();
    expect(reads).toBe(1);

    await advance(RATE * 2);
    expect(reads).toBeGreaterThan(1);

    const readsWhileShown = reads;
    rerender(
      <QueryClientProvider client={client()}>
        <TooltipProvider>
          <DetailTabs
            tabs={tabs()}
            activeTab="overview"
            onTabChange={() => {}}
          />
        </TooltipProvider>
      </QueryClientProvider>
    );
    await settle();

    // The panel is still mounted — that is what `forceMount` is for — and its
    // shell or log stream is still attached. It must not still be polling.
    expect(screen.getByTestId("data")).toBeInTheDocument();
    await advance(RATE * 5);
    expect(reads).toBe(readsWhileShown);
  });

  it("stops re-reading while the window is hidden, and reads again on return", async () => {
    wrap(<Probe />);
    await settle();
    const onArrival = reads;

    act(() => {
      useWindowActivity.setState({ visible: false, focused: false });
    });
    await advance(RATE * 5);
    expect(reads).toBe(onArrival);

    act(() => {
      useWindowActivity.setState({ visible: true, focused: true });
    });
    await settle();
    expect(reads).toBe(onArrival + 1);
  });
});

describe("coming back to a tab", () => {
  it("re-reads the cluster the moment the tab is shown again", async () => {
    const panel = (content: React.ReactNode): DetailTab[] => [
      {
        id: "overview",
        label: "Overview",
        glyph: viewGlyph(LayoutGrid),
        content: <span>overview</span>,
      },
      {
        id: "logs",
        label: "Logs",
        kind: "surface",
        glyph: viewGlyph(FileText),
        content,
      },
    ];
    const shared = client();
    const draw = (activeTab: string) => (
      <QueryClientProvider client={shared}>
        <TooltipProvider>
          <DetailTabs
            tabs={panel(<Probe />)}
            activeTab={activeTab}
            onTabChange={() => {}}
          />
        </TooltipProvider>
      </QueryClientProvider>
    );

    const { rerender } = render(draw("logs"));
    await settle();

    rerender(draw("overview"));
    await settle();
    const whileHidden = reads;

    // Away long enough that the number on screen has stopped being the
    // cluster's. Returning must correct it before it can be read as current.
    await advance(60_000);
    expect(reads).toBe(whileHidden);

    rerender(draw("logs"));
    await settle();
    expect(reads).toBe(whileHidden + 1);
  });
});

describe("what a backed-off query says about itself", () => {
  it("stops saying it is polling once it has slowed down", async () => {
    wrap(<Probe />);
    await settle();
    expect(screen.getByText("polling")).toBeInTheDocument();

    // Identical answers, over and over, until the interval has grown past the
    // rate the word "polling" stands for.
    for (let round = 0; round <= BACKOFF.steadyAfter; round++) {
      await advance(RATE * 2);
    }

    expect(screen.getByText("slowed")).toBeInTheDocument();
    expect(screen.queryByText("polling")).not.toBeInTheDocument();
    // And it may never have been the other word. A poll that has backed off is
    // the exact case a green "live" would be a lie about.
    expect(screen.queryByText("live")).not.toBeInTheDocument();
  });

  it("comes back up to rate the moment the reader touches the window", async () => {
    wrap(<Probe />);
    await settle();
    for (let round = 0; round <= BACKOFF.steadyAfter; round++) {
      await advance(RATE * 2);
    }
    expect(screen.getByText("slowed")).toBeInTheDocument();

    act(() => {
      useWindowActivity.setState({ interactionAt: Date.now() });
    });
    await settle();
    expect(screen.getByText("polling")).toBeInTheDocument();
  });
});

describe("one question asked of several namespaces", () => {
  /**
   * Would put the fan-out's whole cost back. A page reading four namespaces
   * at the fast rate is four requests a second, and the one rule that stops
   * an idle screen paying it is the one a group had no way to apply.
   */
  it("goes quiet when every part has stopped changing", async () => {
    wrap(<Fanout />);
    await settle();
    for (let round = 0; round <= BACKOFF.steadyAfter; round++) {
      await advance(RATE * 2);
    }
    expect(screen.getByText("slowed")).toBeInTheDocument();

    const settled = reads;
    // A minute of two queries at the base rate is sixty reads. Backed off,
    // it is a handful — the interval is still climbing to the cap.
    await advance(BACKOFF.cap * 2);
    expect(reads - settled).toBeLessThan(10);
  });

  /**
   * Would be the worse failure of the two: a scope where one namespace is
   * quiet and one is on fire is exactly when the reader is watching, and the
   * join is not steady while any part of it is still moving.
   */
  it("stays at full rate while one part is still moving", async () => {
    wrap(<Fanout moving />);
    await settle();
    for (let round = 0; round <= BACKOFF.steadyAfter; round++) {
      await advance(RATE * 2);
    }
    expect(screen.getByText("polling")).toBeInTheDocument();
    expect(screen.queryByText("slowed")).not.toBeInTheDocument();
  });

  /**
   * Would put back the one shape where counting arrivals rather than rounds
   * shows: at the scope limit, three quiet parts reach `steadyAfter` on their
   * own in the gap between two answers from a fourth that is changing every
   * poll. The rate then flipped between 1s and 2s once a second and the badge
   * over moving data flipped between "polling" and "slowed" with it — both
   * invisible to an assertion made after the round has finished, which is why
   * every interval the group holds is recorded.
   */
  it("never slows a group at the scope limit while one part keeps changing", async () => {
    const held: Array<number | false> = [];
    wrap(
      <Fanout
        parts={SCOPE_LIMIT}
        moving
        refresh="fast"
        stagger={10}
        onInterval={(everyMs) => {
          held.push(everyMs);
        }}
      />
    );
    for (let round = 0; round <= BACKOFF.steadyAfter * 2; round++) {
      await advance(REFRESH_INTERVALS.fast);
    }

    expect([...new Set(held)]).toEqual([REFRESH_INTERVALS.fast]);
    expect(screen.queryByText("slowed")).not.toBeInTheDocument();
  });

  /**
   * The promise the whole licence to back off rests on, for the one shape
   * that cannot keep it query by query: a fan-out switches React Query's own
   * focus refetch off precisely because it is a fan-out, so nothing but the
   * group is left to re-read it.
   */
  it("re-reads every part on the way back to the window", async () => {
    wrap(<Fanout />);
    await settle();

    act(() => {
      useWindowActivity.setState({ visible: false, focused: false });
    });
    await advance(RATE * 5);
    const whileHidden = reads;

    act(() => {
      useWindowActivity.setState({ visible: true, focused: true });
    });
    await settle();
    expect(reads).toBe(whileHidden + 2);
  });

  /**
   * A group that has gone quiet is a conclusion about a still screen, and a
   * reader clicking about in one is evidence against it. Without this, an
   * events page fanned out over four namespaces stayed at the 30s cap for as
   * long as the reader kept it open.
   */
  it("comes back up to rate the moment the reader touches the window", async () => {
    wrap(<Fanout />);
    await settle();
    for (let round = 0; round <= BACKOFF.steadyAfter; round++) {
      await advance(RATE * 2);
    }
    expect(screen.getByText("slowed")).toBeInTheDocument();

    act(() => {
      useWindowActivity.setState({ interactionAt: Date.now() });
    });
    await settle();
    expect(screen.getByText("polling")).toBeInTheDocument();
  });
});
