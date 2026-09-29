import { render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { ColumnDef } from "@/components/ui/table-features";
import { useLocaleStore } from "@/stores/localeStore";
import { columns } from "./CronJobList";

const cellOf = (id: string, original: object) => {
  const column = (columns() as ColumnDef<never>[]).find((c) => c.id === id);
  const cell = column?.cell;
  if (typeof cell !== "function") throw new Error(`no ${id} cell`);
  return render(<>{cell({ row: { original } } as never)}</>).container;
};

describe("what the CronJob list says about schedules", () => {
  afterEach(() => useLocaleStore.setState({ choice: null }));

  /**
   * Both cells carried English literals — "No", "ago", "Never" — in a table
   * whose headers and neighbours were already Russian.
   */
  it("says a cronjob is not suspended in the reader's language", () => {
    useLocaleStore.setState({ choice: "ru" });
    expect(cellOf("suspend", { suspend: false })).toHaveTextContent(/^Нет$/);
  });

  /** Would break if the age were glued to an English "ago" again. */
  it("says how long ago it last ran in the reader's language", () => {
    useLocaleStore.setState({ choice: "ru" });
    const cell = cellOf("last_schedule", {
      lastSchedule: new Date(Date.now() - 5 * 60_000).toISOString(),
    });
    expect(cell).toHaveTextContent(/назад$/);
    expect(cell.textContent).not.toMatch(/ago/);
  });

  /** Would break if a cronjob that never ran printed "Never" again. */
  it("says it never ran in the reader's language", () => {
    useLocaleStore.setState({ choice: "ru" });
    expect(cellOf("last_schedule", { lastSchedule: null })).toHaveTextContent(
      /^никогда$/
    );
  });
});
