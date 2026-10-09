import { readFileSync } from "node:fs";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";

import { CODE_FILES } from "@/test/source-files";
import { Table, TableActionCell, TableBody, TableRow } from "./table";

describe("the cell that holds a row's last button", () => {
  /**
   * WebKitGTK's overlay scrollbar takes the pointer over a scrolling port's
   * last 21px, which is where a right-aligned button of a plain cell sat.
   * Fails if the cell gives up the 24px DataTable keeps, or stops pushing
   * its button to the right edge.
   */
  it("keeps its button right of the content and clear of the scrollbar", () => {
    render(
      <Table>
        <TableBody>
          <TableRow>
            <TableActionCell>
              <button type="button">Remove</button>
            </TableActionCell>
          </TableRow>
        </TableBody>
      </Table>
    );
    const cell = screen.getByRole("button", { name: "Remove" }).closest("td");
    expect(cell).toHaveStyle({ paddingRight: "24px" });
    expect(cell?.firstElementChild).toHaveClass("flex", "justify-end");
  });

  /**
   * A table built by hand put its last button in an ordinary cell inside a
   * right-aligned span, once for each of four Helm tables. Fails when a
   * cell of that shape comes back.
   */
  it("is the only way a table right-aligns what its last cell holds", () => {
    const offenders = CODE_FILES.filter(
      (path) => !path.endsWith("/components/ui/table.tsx")
    ).filter((path) =>
      /<TableCell>\s*<span className="flex justify-end">/.test(
        readFileSync(path, "utf8")
      )
    );
    expect(CODE_FILES.length).toBeGreaterThan(500);
    expect(offenders).toEqual([]);
  });
});
