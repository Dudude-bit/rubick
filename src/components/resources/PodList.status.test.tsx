import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { CellContext, ColumnDef } from "@/components/ui/table-features";

import { columns } from "./PodList";

/**
 * The status column, rendered on its own.
 *
 * The cell is the whole subject here — mounting the page would drag in the
 * cluster store, three queries and a table just to read one badge.
 */
type Row = {
  status: { display: string; phase: string };
  nodeSilence?: unknown;
};

function statusCell(original: Row) {
  const column = (columns as ColumnDef<Row>[]).find((c) => c.id === "status");
  if (!column || typeof column.cell !== "function") {
    throw new Error("the pod list has no status column with a renderer");
  }
  const context = { row: { original } } as unknown as CellContext<Row, unknown>;
  return column.cell(context);
}

const RUNNING = { display: "Running", phase: "Running" };

describe("a pod whose node stopped reporting", () => {
  /**
   * The defect this exists for. When a node stops answering, nothing rewrites
   * its pods: `Running` stays written until eviction, five minutes later by
   * default and never at all for a StatefulSet until the node object goes. A
   * client that draws that confidently is reporting a moment that has passed.
   */
  it("keeps kubectl's label but stops sounding certain about it", () => {
    render(
      <>
        {statusCell({
          status: RUNNING,
          nodeSilence: { node: "n1", since: null, reason: null },
        })}
      </>
    );

    // The label is not softened — this IS the status the cluster holds, and a
    // second opinion invented here would be a different lie.
    const badge = screen.getByText("Running");
    expect(badge).toBeInTheDocument();

    // The colour is what drops: neutral is this app's "no opinion" role.
    expect(badge.closest("[title]")?.className ?? badge.className).toContain(
      "text-fg-mut"
    );
  });

  it("says which node went quiet, and that the status is old rather than wrong", () => {
    render(
      <>
        {statusCell({
          status: RUNNING,
          nodeSilence: {
            node: "worker-3",
            since: new Date(Date.now() - 240_000).toISOString(),
            reason: "NodeStatusUnknown",
          },
        })}
      </>
    );

    const titled = screen.getByTitle(/worker-3/);
    expect(titled.getAttribute("title")).toContain("stopped reporting 4m ago");
    expect(titled.getAttribute("title")).toContain("last one it sent");
  });
});

describe("a pod whose node is answering", () => {
  /** Would have fired the warning on every healthy cluster. */
  it("is drawn exactly as before, with the phase in the tooltip", () => {
    render(<>{statusCell({ status: RUNNING })}</>);

    const badge = screen.getByText("Running");
    expect(badge.className).not.toContain("text-fg-mut");
    expect(screen.getByTitle("Phase Running")).toBeInTheDocument();
  });

  /** The role still comes from the status, not from the node. */
  it("still reads a crash loop as an error", () => {
    render(
      <>
        {statusCell({
          status: { display: "CrashLoopBackOff", phase: "Running" },
        })}
      </>
    );
    expect(screen.getByText("CrashLoopBackOff").className).toContain(
      "text-err"
    );
  });
});
