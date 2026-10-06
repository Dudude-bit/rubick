import { describe, expect, it } from "vite-plus/test";

import { translate } from "@/i18n";
import { columnHeader } from "@/i18n/column-header";
import type { T } from "@/i18n/useT";
import { headerFloor } from "./column-label";

const ru: T = (section, key, values) => translate("ru", section, key, values);

describe("the room a header needs", () => {
  /**
   * Lena's Pods table read "Готовн...", "Перезапу..." and "Возр..." with room
   * to spare. Fails if a floor stops covering the whole label, and the sort
   * mark beside it where the header is a sort control.
   */
  it("covers the whole label, and the sort mark of a sortable one", () => {
    expect(headerFloor({ header: columnHeader("columns", "age") }, ru)).toBe(
      Math.ceil("Возраст".length * 6.8 + 20)
    );
    expect(
      headerFloor(
        {
          header: () => null,
          meta: { label: { section: "columns", key: "restarts" } },
        },
        ru
      )
    ).toBe(Math.ceil("Перезапуски".length * 6.8 + 18 + 20));
  });

  /** Fails if a column with no words in its header claims room for some. */
  it("needs nothing for a header with no words", () => {
    expect(headerFloor({ header: () => null }, ru)).toBe(0);
  });
});
