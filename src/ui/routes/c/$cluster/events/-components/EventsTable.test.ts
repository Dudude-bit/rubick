import { describe, expect, it } from "vite-plus/test";

import { tableLayout } from "@/components/ui/column-shares";
import type { ColumnDef } from "@/components/ui/table-features";
import type { EventInfo } from "@/generated/types";
import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import { columnFloor, columnIdeal } from "@/lib/column-label";

import { EVENT_COLUMNS } from "./EventsTable";

const {
  everyNamespace: EVERY_NAMESPACE,
  oneNamespace: ONE_NAMESPACE,
  objectPx: OBJECT_CELL_PX,
  messagePx: messageCellPx,
} = EVENT_COLUMNS;

const en: T = (section, key, values) => translate("en", section, key, values);
const ru: T = (section, key, values) => translate("ru", section, key, values);

/** The window less the 209px sidebar, the page's 32px of gutter and the 8px scrollbar lane, and the 480px peek when it is open. */
const port = (window: number, peek: boolean) =>
  window - 209 - 32 - 8 - (peek ? 480 : 0);

/** Each column's pixels as `DataTable` lays the Events table out in `width`. */
function laidOut(
  columns: readonly ColumnDef<EventInfo>[],
  width: number,
  t: T
) {
  const layout = tableLayout(
    columns.map((column) => ({
      size: column.size ?? 150,
      floor: columnFloor(column, t),
      ideal: columnIdeal(column, t),
    })),
    width
  );
  const px = layout.shares.map(
    (share) => Math.round(share * layout.span * 10) / 1000
  );
  const of = (id: string) => px[columns.findIndex((c) => c.id === id)];
  return {
    reason: of("reason"),
    object: of("object"),
    message: of("message"),
  };
}

/** 12px JetBrains Mono, both marks with their gaps, and a cell's padding. */
const oneLine = (reason: string) => reason.length * 7.2 + 32 + 20;

const TABLES = [
  ["one namespace", ONE_NAMESPACE],
  ["every namespace", EVERY_NAMESPACE],
] as const;

describe("the Events table with a peek open at 1024", () => {
  /**
   * Lena's Object column was three letters, "ini", "top", "cro" for a
   * CronJob, a Job and a Pod alike. Fails if the column can be drawn under
   * the kind glyph and fifteen glyphs of name, or if the reason before it
   * pushes any of it past the port before the reader scrolls.
   */
  it.each(TABLES)(
    "keeps a recognisable object name in sight, %s",
    (_scope, columns) => {
      for (const t of [en, ru]) {
        const { reason, object } = laidOut(columns, port(1024, true), t);
        expect(object).toBeGreaterThanOrEqual(OBJECT_CELL_PX);
        expect(reason + object).toBeLessThanOrEqual(port(1024, true));
      }
    }
  );

  /**
   * Dana scrolled to Message beside a peek and read "Conta…", "Job h…" and
   * "Back-…": the column was as wide as its header. Fails if a message can
   * be drawn narrower than its opening words.
   */
  it.each(TABLES)(
    "keeps a message's opening words readable, %s",
    (_scope, columns) => {
      for (const t of [en, ru]) {
        const { message } = laidOut(columns, port(1024, true), t);
        expect(message).toBeGreaterThanOrEqual(messageCellPx());
        expect(messageCellPx()).toBeGreaterThanOrEqual(
          "Back-off restart".length * 6
        );
      }
    }
  );

  /** Fails if the reason column can get narrower than the longest word a reason is made of, which would cut inside a word. */
  it.each(TABLES)(
    "never cuts inside a reason's word, %s",
    (_scope, columns) => {
      const { reason } = laidOut(columns, port(1024, true), ru);
      expect(reason).toBeGreaterThanOrEqual(oneLine("Unschedulable"));
    }
  );
});

describe("the Events table with room", () => {
  /**
   * Lena read "FailedSc…", "Successf…" and "SawCompl…" at 1024, and Dana
   * "Succ…" for both SuccessfulCreate and SuccessfulDelete. Fails if the
   * reasons a cluster writes all day stop fitting on one line where the
   * table has room for them.
   */
  it.each([
    ["1024 in Russian", port(1024, false), ru, ONE_NAMESPACE],
    [
      "1024 in Russian, every namespace",
      port(1024, false),
      ru,
      EVERY_NAMESPACE,
    ],
    ["1400 in English with a peek", port(1400, true), en, EVERY_NAMESPACE],
  ] as const)(
    "holds a common reason on one line at %s",
    (_at, width, t, columns) => {
      const { reason } = laidOut(columns, width, t);
      for (const common of ["SuccessfulCreate", "ScalingReplicaSet"])
        expect(reason).toBeGreaterThanOrEqual(oneLine(common));
    }
  );
});
