import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

import { DrainDialog } from "./drain-dialog";
import type { DrainReport, DrainState, RefusedPod } from "@/hooks/useNodeDrain";

const wrap = (ui: ReactNode) =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>
  );

const refused = (over: Partial<RefusedPod> = {}): RefusedPod => ({
  namespace: "prod",
  name: "api-7f9",
  refusal: "notNow",
  message: null,
  ...over,
});

const report = (over: Partial<DrainReport> = {}): DrainReport => ({
  evicted: 12,
  alreadyGone: 0,
  daemonsetPodsLeft: 0,
  refused: [refused()],
  ...over,
});

const dialog = (
  state: DrainState,
  over: Partial<Parameters<typeof DrainDialog>[0]> = {}
) => (
  <DrainDialog
    node="node-7"
    state={state}
    onOpenChange={() => {}}
    onConfirm={() => {}}
    onCancelDrain={() => {}}
    {...over}
  />
);

describe("confirming a drain", () => {
  /**
   * The whole of the security report, as a test of the click. The old list
   * called `drainNode(node, true, true)` — both opt-ins hard on, no way to
   * turn them off — so every drain was authorised to end pods nothing would
   * bring back.
   */
  it("asks for nothing destructive unless it is ticked", async () => {
    const onConfirm = vi.fn();
    wrap(dialog({ phase: "idle" }, { onConfirm }));

    await userEvent.click(screen.getByRole("button", { name: /drain/i }));

    expect(onConfirm).toHaveBeenCalledWith("node-7", {
      evictUnmanagedPods: false,
      evictPodsWithEmptydir: false,
    });
  });

  it("carries a ticked opt-in through to the caller", async () => {
    const onConfirm = vi.fn();
    wrap(dialog({ phase: "idle" }, { onConfirm }));

    await userEvent.click(
      screen.getByRole("checkbox", { name: /nothing would replace/i })
    );
    await userEvent.click(screen.getByRole("button", { name: /drain/i }));

    expect(onConfirm).toHaveBeenCalledWith("node-7", {
      evictUnmanagedPods: true,
      evictPodsWithEmptydir: false,
    });
  });

  /**
   * Each node is its own decision. An opt-in answered for one node that
   * carried over to the next would be the dialog answering a question this
   * reader was never asked — and the question ends pods.
   */
  it("starts the next node from a clean pair of opt-ins", async () => {
    const onConfirm = vi.fn();
    const view = wrap(dialog({ phase: "idle" }, { onConfirm }));

    await userEvent.click(
      screen.getByRole("checkbox", { name: /nothing would replace/i })
    );

    view.rerender(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <MemoryRouter>
          <DrainDialog
            node="node-8"
            state={{ phase: "idle" }}
            onOpenChange={() => {}}
            onConfirm={onConfirm}
            onCancelDrain={() => {}}
          />
        </MemoryRouter>
      </QueryClientProvider>
    );

    await userEvent.click(screen.getByRole("button", { name: /drain/i }));

    expect(onConfirm).toHaveBeenCalledWith("node-8", {
      evictUnmanagedPods: false,
      evictPodsWithEmptydir: false,
    });
  });

  /** It says what will happen, and the promise is now one the backend keeps. */
  it("says it will keep asking, which is what the backend does", () => {
    wrap(dialog({ phase: "idle" }));

    expect(
      screen.getByText(/keeps asking about the rest/i)
    ).toBeInTheDocument();
  });
});

describe("watching a drain run", () => {
  const running = (
    over: Partial<DrainReport> = {},
    attempt = 3
  ): DrainState => ({
    phase: "running",
    node: "node-7",
    attempt,
    report: report(over),
  });

  /**
   * The reason this is a dialog and not a spinner: "still waiting" and
   * "stuck" look identical without a count of tries.
   */
  it("says which try it is on, so waiting is legible", () => {
    wrap(dialog(running()));

    expect(screen.getByText(/try 3/i)).toBeInTheDocument();
    expect(screen.getByText(/waiting on one pod/i)).toBeInTheDocument();
  });

  it("offers a way to stop, and stopping calls back", async () => {
    const onCancelDrain = vi.fn();
    wrap(dialog(running(), { onCancelDrain }));

    await userEvent.click(
      screen.getByRole("button", { name: /stop draining/i })
    );

    expect(onCancelDrain).toHaveBeenCalledOnce();
  });

  /** Leaving is allowed; it just does not stop the cluster doing the work. */
  it("says that closing the window does not stop it", () => {
    wrap(dialog(running()));

    expect(screen.getByText(/does not stop the drain/i)).toBeInTheDocument();
  });

  /** The first attempt is not worth announcing as a retry. */
  it("does not call the first look a retry", () => {
    wrap(dialog(running({}, 1)));

    expect(screen.queryByText(/try 1/i)).not.toBeInTheDocument();
  });
});

describe("reading how a drain ended", () => {
  const ended = (
    outcome: "drained" | "stopped" | "cancelled",
    over: Partial<DrainReport> = {}
  ): DrainState => ({
    phase: "done",
    node: "node-7",
    outcome,
    report: report(over),
    message: null,
  });

  it("names every pod that stayed and why", () => {
    wrap(
      dialog(
        ended("stopped", {
          refused: [
            refused(),
            refused({
              name: "batch-1",
              namespace: "ops",
              refusal: "nothingWouldReplaceIt",
            }),
          ],
        })
      )
    );

    expect(screen.getByText("prod/api-7f9")).toBeInTheDocument();
    expect(screen.getByText(/refused for now/i)).toBeInTheDocument();
    expect(screen.getByText("ops/batch-1")).toBeInTheDocument();
    expect(screen.getByText(/nothing would replace it/i)).toBeInTheDocument();
  });

  /**
   * A 429 is not knowably the budget — Kubernetes answers the same code when
   * it is pacing itself, and nothing in the response tells the two apart. So
   * the line hedges, on purpose.
   */
  it("does not claim the budget was the reason", () => {
    wrap(dialog(ended("cancelled")));

    expect(
      screen.getByText(/usually a disruption budget/i)
    ).toBeInTheDocument();
  });

  /** The two lists mean different things and get different advice. */
  it("tells apart what is waiting from what will never move", () => {
    wrap(
      dialog(
        ended("stopped", {
          refused: [refused({ refusal: "holdsLocalData" })],
        })
      )
    );

    expect(
      screen.getByText(/needs an answer only you can give/i)
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/usually a disruption budget/i)
    ).not.toBeInTheDocument();
  });

  /** When the app has no name for a failure, the server's own words run. */
  it("quotes the server for a failure it cannot name", () => {
    wrap(
      dialog(
        ended("stopped", {
          refused: [
            refused({
              refusal: "other",
              message: 'pods "api-7f9" is forbidden',
            }),
          ],
        })
      )
    );

    expect(screen.getByText(/is forbidden/)).toBeInTheDocument();
  });

  /** The counts have to add up to what was on the node. */
  it("accounts for the pods it neither moved nor was refused", () => {
    wrap(dialog(ended("stopped", { alreadyGone: 2, daemonsetPodsLeft: 3 })));

    expect(screen.getByText(/3 DaemonSet pods stay/i)).toBeInTheDocument();
    expect(
      screen.getByText(/2 pods had already gone on their own/i)
    ).toBeInTheDocument();
  });

  it("says who stopped it when it was the operator", () => {
    wrap(dialog(ended("cancelled")));

    expect(screen.getByText(/you stopped the drain/i)).toBeInTheDocument();
  });

  /**
   * Two different failures wear the same word. This one broke while running,
   * so it still knows what it had already moved; the `failed` phase below is
   * the command being refused before any drain existed, and knows nothing.
   */
  it("keeps the count when a running drain breaks", () => {
    wrap(
      dialog({
        phase: "done",
        node: "node-7",
        outcome: "failed",
        report: report({ evicted: 9, refused: [] }),
        message: "the connection was reset",
      })
    );

    expect(screen.getByText(/the drain broke/i)).toBeInTheDocument();
    expect(screen.getByText(/9 pods moved off/i)).toBeInTheDocument();
    expect(screen.getByText(/connection was reset/i)).toBeInTheDocument();
  });

  /** A drain that never started is its own state, not an empty report. */
  it("shows what broke when the drain could not start", () => {
    wrap(
      dialog({
        phase: "failed",
        node: "node-7",
        message: 'nodes "node-7" is forbidden',
      })
    );

    expect(screen.getByText(/is forbidden/)).toBeInTheDocument();
    // Nothing is running, so there is nothing to stop.
    expect(
      screen.queryByRole("button", { name: /stop draining/i })
    ).not.toBeInTheDocument();
  });
});
