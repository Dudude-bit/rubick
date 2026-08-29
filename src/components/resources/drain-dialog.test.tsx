import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

import { DrainDialog } from "./drain-dialog";
import type { DrainReport, RefusedPod } from "@/generated/types";

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

describe("confirming a drain", () => {
  /**
   * The whole of the security report, as a test of the click. The old list
   * called `drainNode(node, true, true)` — both opt-ins hard on, no way to
   * turn them off — so every drain was authorised to end pods nothing would
   * bring back.
   */
  it("asks for nothing destructive unless it is ticked", async () => {
    const onConfirm = vi.fn();
    wrap(
      <DrainDialog
        node="node-7"
        report={null}
        onOpenChange={() => {}}
        onConfirm={onConfirm}
        busy={false}
      />
    );

    await userEvent.click(screen.getByRole("button", { name: /drain/i }));

    expect(onConfirm).toHaveBeenCalledWith("node-7", {
      evictUnmanagedPods: false,
      evictPodsWithLocalData: false,
    });
  });

  it("carries a ticked opt-in through to the caller", async () => {
    const onConfirm = vi.fn();
    wrap(
      <DrainDialog
        node="node-7"
        report={null}
        onOpenChange={() => {}}
        onConfirm={onConfirm}
        busy={false}
      />
    );

    await userEvent.click(
      screen.getByRole("checkbox", { name: /nothing would replace/i })
    );
    await userEvent.click(screen.getByRole("button", { name: /drain/i }));

    expect(onConfirm).toHaveBeenCalledWith("node-7", {
      evictUnmanagedPods: true,
      evictPodsWithLocalData: false,
    });
  });

  /**
   * Each node is its own decision. An opt-in answered for one node that
   * carried over to the next would be the dialog answering a question this
   * reader was never asked — and the question ends pods.
   */
  it("starts the next node from a clean pair of opt-ins", async () => {
    const onConfirm = vi.fn();
    const view = wrap(
      <DrainDialog
        node="node-7"
        report={null}
        onOpenChange={() => {}}
        onConfirm={onConfirm}
        busy={false}
      />
    );

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
            report={null}
            onOpenChange={() => {}}
            onConfirm={onConfirm}
            busy={false}
          />
        </MemoryRouter>
      </QueryClientProvider>
    );

    await userEvent.click(screen.getByRole("button", { name: /drain/i }));

    expect(onConfirm).toHaveBeenCalledWith("node-8", {
      evictUnmanagedPods: false,
      evictPodsWithLocalData: false,
    });
  });

  /** It says what will happen, and what will not. */
  it("does not promise to wait", () => {
    wrap(
      <DrainDialog
        node="node-7"
        report={null}
        onOpenChange={() => {}}
        onConfirm={() => {}}
        busy={false}
      />
    );

    expect(
      screen.getByText(/moves what it can and stops at the rest/i)
    ).toBeInTheDocument();
    expect(screen.queryByText(/keep waiting/i)).not.toBeInTheDocument();
  });
});

describe("reading what a drain left behind", () => {
  it("names every pod that stayed and why", () => {
    wrap(
      <DrainDialog
        node="node-7"
        report={report({
          refused: [
            refused(),
            refused({
              name: "batch-1",
              namespace: "ops",
              refusal: "nothingWouldReplaceIt",
            }),
          ],
        })}
        onOpenChange={() => {}}
        onConfirm={() => {}}
        busy={false}
      />
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
    wrap(
      <DrainDialog
        node="node-7"
        report={report()}
        onOpenChange={() => {}}
        onConfirm={() => {}}
        busy={false}
      />
    );

    expect(
      screen.getByText(/usually a disruption budget/i)
    ).toBeInTheDocument();
  });

  /** When the app has no name for a failure, the server's own words run. */
  it("quotes the server for a failure it cannot name", () => {
    wrap(
      <DrainDialog
        node="node-7"
        report={report({
          refused: [
            refused({
              refusal: "other",
              message: 'pods "api-7f9" is forbidden',
            }),
          ],
        })}
        onOpenChange={() => {}}
        onConfirm={() => {}}
        busy={false}
      />
    );

    expect(screen.getByText(/is forbidden/)).toBeInTheDocument();
  });

  /** The counts have to add up to what was on the node. */
  it("accounts for the pods it neither moved nor was refused", () => {
    wrap(
      <DrainDialog
        node="node-7"
        report={report({ alreadyGone: 2, daemonsetPodsLeft: 3 })}
        onOpenChange={() => {}}
        onConfirm={() => {}}
        busy={false}
      />
    );

    expect(screen.getByText(/3 DaemonSet pods stay/i)).toBeInTheDocument();
    expect(
      screen.getByText(/2 pods had already gone on their own/i)
    ).toBeInTheDocument();
  });
});
