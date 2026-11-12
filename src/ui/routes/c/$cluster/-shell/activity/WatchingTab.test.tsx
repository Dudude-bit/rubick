import { afterEach, describe, expect, it } from "vite-plus/test";
import { screen } from "@testing-library/react";

import { renderWithProviders } from "@/test/render";
import type { Watch } from "@/lib/tell-me-when";
import { useClusterStore } from "@/stores/clusterStore";
import { useTellMeWhenStore } from "@/stores/tellMeWhenStore";
import { WatchingTab } from "./WatchingTab";

const watch = (id: string, at: number): Watch => ({
  id,
  context: "k3d",
  kind: "Deployment",
  namespace: "lena-sandbox",
  name: "hello-web",
  ask: "rollout",
  startedAt: at,
  status: {
    state: "done",
    verdict: { says: "rolledOut", detail: "1 of 1 ready, revision 4" },
    at,
  },
  baseline: null,
});

afterEach(() => {
  useTellMeWhenStore.setState({ watches: [] });
});

describe("the Watching tab's rows", () => {
  /**
   * Three restarts of one Deployment read "Deployment lena-sandbox/hello-web ·
   * развёртыван…" and differed only by an age cut off the second line. Fails
   * if either line goes back to ending in an ellipsis.
   */
  it("wraps both lines of a row instead of cutting them", () => {
    useClusterStore.setState({ currentContext: "k3d" });
    useTellMeWhenStore.setState({
      watches: [watch("a", Date.now()), watch("b", Date.now() - 60_000)],
    });
    renderWithProviders(<WatchingTab />);
    const first = screen.getAllByText(/hello-web/)[0].closest("span.block");
    expect(first).not.toHaveClass("truncate");
    expect(first).toHaveClass("break-words");
    const detail = screen.getAllByText(/1 of 1 ready, revision 4/)[0];
    expect(detail).not.toHaveClass("truncate");
    expect(detail).toHaveClass("break-words");
  });

  /**
   * Dana's Watching row read "search rollout failed" while the peek's badge
   * for the same Deployment said Stalled. Fails if the row words a verdict
   * differently from the toast, or says failed for a stall.
   */
  it("says stalled for a rollout past its deadline, as the toast and the peek do", () => {
    useClusterStore.setState({ currentContext: "k3d" });
    const at = Date.now();
    useTellMeWhenStore.setState({
      watches: [
        {
          ...watch("stall", at),
          namespace: "shop",
          name: "search",
          status: {
            state: "done",
            verdict: {
              says: "rolloutFailed",
              detail:
                'ProgressDeadlineExceeded: ReplicaSet "search-595848f55c" has timed out progressing.',
            },
            at,
          },
        },
      ],
    });
    renderWithProviders(<WatchingTab />);
    expect(screen.getByText(/^search rollout stalled · /)).toBeInTheDocument();
    expect(screen.queryByText(/failed/)).toBeNull();
  });
});
