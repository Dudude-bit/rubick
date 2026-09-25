import { describe, expect, it } from "vitest";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import { tableSection } from "./table-share";

const t: T = (section, key, values) => translate("en", section, key, values);

const column = (id: string) => ({ id, columnDef: { header: id } });

function tableOf(rows: Record<string, unknown>[], ids: string[]) {
  return {
    getVisibleFlatColumns: () => ids.map(column),
    getRowModel: () => ({
      rows: rows.map((original) => ({
        original,
        getVisibleCells: () =>
          ids.map((id) => ({
            column: column(id),
            getValue: () => original[id],
          })),
      })),
    }),
  };
}

describe("the cells a shared table writes", () => {
  /** `Date.parse("110")` is a date in V8, so a chart version or a port was
   *  written into the file as a timestamp. */
  it("writes a version or a port as itself and only an ISO time as a time", () => {
    const section = tableSection(
      tableOf(
        [
          {
            name: "web",
            chart: "110",
            appVersion: "1.2.3",
            lastSeen: "2026-09-25T10:00:00Z",
          },
        ],
        ["chart", "appVersion", "lastSeen"]
      ),
      { title: "Releases" },
      t
    );
    if (section.body.type !== "table") throw new Error("expected a table");
    const [, chart, version, seen] = section.body.rows[0].cells;
    expect(chart).toEqual({ text: "110", mono: true });
    expect(version).toEqual({ text: "1.2.3", mono: true });
    expect(seen).toEqual({
      text: "2026-09-25T10:00:00Z",
      at: "2026-09-25T10:00:00Z",
    });
  });
});
