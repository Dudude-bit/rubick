import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";

import type { AppColumnMeta, ColumnDef } from "@/components/ui/table-features";
import type { Rollout } from "@/generated/types";
import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import type { RowCause } from "./row-cause";
import { createRolloutColumn } from "./rollout-column";

type Row = { rollout: Rollout; podsCause: RowCause };

const column = createRolloutColumn<Row>() as ColumnDef<never>;
const t: T = (section, key, values) => translate("en", section, key, values);

const told: RowCause = {
  says: "read",
  shared: {
    pods: 1,
    of: 1,
    cause: {
      says: "exits",
      container: "app",
      restarts: 7,
      run: null,
      until: null,
    },
  },
};

const stalled: Rollout = { state: "stalled", message: null, serving: 0 };

function cell(row: Row) {
  const draw = column.cell;
  if (typeof draw !== "function") throw new Error("no status cell");
  return render(<>{draw({ row: { original: row } } as never)}</>);
}

describe("the status a workload list's row says", () => {
  /**
   * missing-image read "Stalled" in the list and "2 of 2 pods: image not
   * found" everywhere else. Fails if the cell or the shared file drops the
   * cause after the verdict, or tells one beside a rollout that is done.
   */
  it("tells the cause its pods share after the verdict, until the rollout settles", () => {
    cell({ rollout: stalled, podsCause: told });
    expect(screen.getByText("Stalled").closest(".flex-none")).not.toBeNull();
    expect(screen.getByTestId("row-cause")).toHaveTextContent(
      /^1 of 1 pod: app/
    );
    const share = (column.meta as AppColumnMeta).share;
    expect(share?.({ rollout: stalled, podsCause: told } as never, t)).toEqual(
      expect.objectContaining({
        text: expect.stringMatching(/^Stalled · 1 of 1 pod: app/),
        role: "err",
      })
    );
    cell({ rollout: { state: "ready" }, podsCause: told });
    expect(screen.getAllByTestId("row-cause")).toHaveLength(1);
  });

  /**
   * A stalled row whose pods were refused said nothing beside its verdict,
   * which reads as pods with nothing wrong. Fails if it stays quiet, or if a
   * verdict already marked as unchecked against its pods says it twice.
   */
  it("says its pods were not read where the verdict does not already say so", () => {
    cell({ rollout: stalled, podsCause: { says: "unread" } });
    expect(
      screen.getByText("pods not read, so why is not known")
    ).toBeInTheDocument();
    const { container } = cell({
      rollout: { state: "podsUnread", controller: { state: "ready" } },
      podsCause: { says: "unread" },
    });
    expect(container).not.toHaveTextContent("so why is not known");
  });
});
