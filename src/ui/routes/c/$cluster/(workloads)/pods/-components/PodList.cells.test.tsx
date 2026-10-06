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
          row: { original: { restartCount: 7, lastRestartAt } },
        } as never)}
      </>
    );
    expect(screen.getByText("7").closest("[title]")).toHaveAttribute(
      "title",
      expect.stringMatching(/^7 \(.+ ago\)$/)
    );
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
