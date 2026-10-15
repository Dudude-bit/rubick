import { render, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vite-plus/test";

import type { AppColumnMeta, ColumnDef } from "@/components/ui/table-features";
import { translate } from "@/i18n";
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
    expect(cellOf("suspend", { suspend: false })).toHaveTextContent(/^нет$/);
  });

  /** A capital "Нет" here sat beside the lowercase "нет" every empty cell draws. */
  it("cases the resting no like the none word beside it", () => {
    expect(cellOf("suspend", { suspend: false })).toHaveTextContent(/^no$/);
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

  /**
   * The list promises "whether that run succeeded" and had no column that
   * said it: reports looked like every other row while each run failed.
   * Fails if the row or the shared file does not say a run did not succeed,
   * in red, or paints a succeeded one as news.
   */
  it("says whether its newest run succeeded, on the row and in a shared file", () => {
    const failed = {
      active: 0,
      lastSchedule: new Date(Date.now() - 60_000).toISOString(),
      lastSuccessfulTime: null,
      podsCause: { says: "read", shared: null },
    };
    const cell = cellOf("last_run", failed);
    expect(cell).toHaveTextContent(/^did not succeed$/);
    expect(within(cell).getByText("did not succeed")).toHaveClass("text-err");
    const succeeded = cellOf("last_run", {
      ...failed,
      lastSuccessfulTime: new Date().toISOString(),
    });
    expect(within(succeeded).getByText("succeeded")).not.toHaveClass(
      "text-err"
    );
    const column = (columns() as ColumnDef<never>[]).find(
      (c) => c.id === "last_run"
    );
    const share = (column?.meta as AppColumnMeta | undefined)?.share;
    const t = ((section: string, key: string) =>
      translate("ru", section as never, key as never)) as never;
    expect(share?.(failed as never, t)).toEqual({
      text: "не удался",
      role: "err",
    });
  });

  /**
   * The list said a run did not succeed and nothing of why, while the page
   * led with it. Fails if the row does not tell the cause its last run's
   * pods share after the outcome, in the cell and in a shared file, or
   * tells one beside a run that succeeded.
   */
  it("tells the cause its last run's pods share after the outcome", () => {
    const failed = {
      active: 0,
      lastSchedule: new Date(Date.now() - 60_000).toISOString(),
      lastSuccessfulTime: null,
      podsCause: {
        says: "read",
        shared: {
          pods: 2,
          of: 2,
          cause: {
            says: "exits",
            container: "report",
            restarts: 0,
            run: null,
            until: null,
          },
        },
      },
    };
    expect(cellOf("last_run", failed)).toHaveTextContent(
      /^did not succeed2 of 2 pods: report/
    );
    const column = (columns() as ColumnDef<never>[]).find(
      (c) => c.id === "last_run"
    );
    const share = (column?.meta as AppColumnMeta | undefined)?.share;
    const t = ((section: string, key: string, values?: never) =>
      translate("en", section as never, key as never, values)) as never;
    expect(share?.(failed as never, t)).toMatchObject({
      text: expect.stringMatching(/^did not succeed · 2 of 2 pods: report/),
      role: "err",
    });
    expect(
      cellOf("last_run", {
        ...failed,
        lastSuccessfulTime: new Date().toISOString(),
      }).textContent
    ).toBe("succeeded");
  });

  /**
   * The shared file is the second reader of this column: it left the cell
   * empty for a cronjob the screen called "Нет".
   */
  it("gives a shared file the same word the cell draws", () => {
    const column = (columns() as ColumnDef<never>[]).find(
      (c) => c.id === "suspend"
    );
    const share = (column?.meta as AppColumnMeta | undefined)?.share;
    const t = ((section: string, key: string) =>
      translate("ru", section as never, key as never)) as never;
    expect(share?.({ suspend: false } as never, t)).toEqual({
      text: "нет",
      quiet: true,
    });
  });
});
