import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";

import type { ColumnDef } from "@/components/ui/table-features";
import { columns } from "./PodList";

const columnOf = (id: string) => {
  const found = (columns as ColumnDef<never>[]).find((c) => c.id === id);
  if (!found) throw new Error(`the pod list has no ${id} column`);
  return found as { cell: (ctx: never) => ReactNode; header: unknown };
};

describe("what a narrow pod column keeps on hover", () => {
  /** Lena read "7 (3 мин н…" with nothing to hover. Fails if the cut count and age lose their whole text. */
  it("keeps a restart count and the age of the last one whole", () => {
    const lastRestartAt = new Date(Date.now() - 3 * 60_000).toISOString();
    render(
      <>
        {columnOf("restarts").cell({
          row: {
            original: {
              restartCount: 7,
              lastRestartAt,
              status: { display: "Running" },
            },
          },
        } as never)}
      </>
    );
    expect(screen.getByText("7").closest("[title]")).toHaveAttribute(
      "title",
      expect.stringMatching(/^7 \(.+ ago\)$/)
    );
  });

  /**
   * Sam's log-demo pods read "10" and "15" in amber, every restart one their
   * cluster gave them after runs of hours. Fails if restarts that are history
   * are drawn as news, or exits after short runs inside the hour are not.
   */
  it("draws a restart count amber only while the exits keep coming", () => {
    const lastRestartAt = new Date(Date.now() - 5 * 60_000).toISOString();
    const cell = (status: Record<string, string>) =>
      render(
        <>
          {columnOf("restarts").cell({
            row: {
              original: {
                restartCount: 15,
                lastRestartAt,
                status: { display: "Running", ...status },
              },
            },
          } as never)}
        </>
      );
    const history = cell({});
    expect(screen.getByText("15")).not.toHaveClass("text-warn");
    history.unmount();
    cell({
      restartingUntil: new Date(Date.now() + 55 * 60_000).toISOString(),
    });
    expect(screen.getByText("15")).toHaveClass("text-warn");
  });

  /**
   * Sam's init-demo, its init container migrate exiting 1 over and over, drew
   * "13 (3m ago)" grey beside amber checkout loops. Fails if a pod held in
   * an init container's back-off has its restarts drawn as history.
   */
  it("draws an init container's crash loop amber like any other", () => {
    render(
      <>
        {columnOf("restarts").cell({
          row: {
            original: {
              restartCount: 13,
              lastRestartAt: new Date(Date.now() - 3 * 60_000).toISOString(),
              status: { display: "Init:CrashLoopBackOff" },
            },
          },
        } as never)}
      </>
    );
    expect(screen.getByText("13")).toHaveClass("text-warn");
  });

  /** "Готов…" and "Перезап…" could not be read, and a screen reader heard only "sort by this column". */
  it("keeps a cut header whole and names its column to a screen reader", () => {
    const header = columnOf("ready").header as (ctx: never) => ReactNode;
    render(
      <>
        {header({
          column: { getIsSorted: () => false, toggleSorting: () => {} },
        } as never)}
      </>
    );
    const button = screen.getByRole("button", { name: /^Ready: / });
    expect(button).toHaveAttribute("title", "Ready");
  });
});
