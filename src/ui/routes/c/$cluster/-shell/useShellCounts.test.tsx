import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vite-plus/test";

const read = vi.hoisted(() => ({
  overview: undefined as unknown,
  at: 0,
  attention: { total: 0 },
}));

vi.mock("@/hooks/useAttention", () => ({
  useAttention: () => read.attention,
}));
vi.mock("@/hooks/useClusterOverview", () => ({
  WATCHED_COUNTS: {},
  useOverviewFollowed: () => false,
  useOverviewFollowedAt: () => null,
  useScopedOverview: () => ({
    data: read.overview,
    dataUpdatedAt: read.at,
    isPlaceholderData: false,
    freshness: { everyMs: false, slowRead: false, stale: false },
  }),
}));

import { namesRebound } from "@/lib/kept-by-name";
import { useClusterStore } from "@/stores/clusterStore";
import { useShellCounts } from "./useShellCounts";

const COUNTS = { counts: { pods: 41 } };

beforeEach(() => {
  read.overview = COUNTS;
  read.at = 1_000;
  useClusterStore.setState({
    currentContext: "default",
    isConnected: true,
    pendingContext: null,
    namespaceScope: [],
    turnedAt: 0,
  });
});

/** The window comes back to `default` with its cache emptied, as a tab switch leaves it. */
function comeBack(view: { rerender: () => void }) {
  read.overview = undefined;
  read.at = 0;
  act(() => useClusterStore.setState({ turnedAt: 2_000 }));
  view.rerender();
}

/**
 * The last complete counts of a cluster stand in, marked, while the window
 * comes back to it. They are kept under its context name, and k3s names
 * every cluster `default`: after the kubeconfig files change the name can be
 * another cluster, which would wear the last one's counts until its own
 * answer lands, and for good where it refuses the read. Fails if the counts
 * kept under a name outlive the files that gave the name its meaning.
 */
it("forgets the counts held for a name when the kubeconfig files change", () => {
  const view = renderHook(() => useShellCounts());
  comeBack(view);
  expect(view.result.current).toMatchObject({
    overview: COUNTS,
    heldAt: 1_000,
  });

  act(() => namesRebound());
  view.rerender();

  expect(view.result.current).toMatchObject({
    overview: undefined,
    heldAt: null,
    readAt: null,
  });
});
