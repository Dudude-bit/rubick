import { readFileSync } from "node:fs";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";

import { pageScroll } from "@/lib/page-scroll";

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

describe("a table's scroll port across pages", () => {
  const port = (name: string) =>
    screen.getByRole("table", { name }).parentElement as HTMLElement;

  async function twoLists() {
    const root = createRootRoute({ component: Outlet });
    const list = (path: string) =>
      createRoute({
        getParentRoute: () => root,
        path,
        component: () => <Table aria-label={path} />,
      });
    const router = createRouter({
      routeTree: root.addChildren([list("/configmaps"), list("/secrets")]),
      history: createMemoryHistory({ initialEntries: ["/configmaps"] }),
      ...pageScroll,
    });
    await act(() => router.load());
    render(<RouterProvider router={router} />);
    await screen.findByRole("table", { name: "/configmaps" });
    return router;
  }

  /**
   * The router copies a scroll box's offset to whatever sits at the same
   * DOM path on the next page, and every list's port sits at the same path:
   * Secrets opened at the row ConfigMaps had been scrolled to. Fails if the
   * port stops being named as the page's own.
   */
  it("opens at the top on a list reached from a scrolled one", async () => {
    const router = await twoLists();
    port("/configmaps").scrollTop = 400;
    port("/configmaps").dispatchEvent(new Event("scroll"));

    await act(async () => {
      router.history.push("/secrets");
      await router.load();
    });
    await screen.findByRole("table", { name: "/secrets" });

    expect(port("/secrets").scrollTop).toBe(0);
  });

  /** Fails if naming the port costs the list its place on the way back. */
  it("is put back where it was on the way back", async () => {
    const router = await twoLists();
    port("/configmaps").scrollTop = 400;
    port("/configmaps").dispatchEvent(new Event("scroll"));
    await act(async () => {
      router.history.push("/secrets");
      await router.load();
    });
    await screen.findByRole("table", { name: "/secrets" });

    await act(async () => {
      router.history.back();
      await router.load();
    });
    await screen.findByRole("table", { name: "/configmaps" });

    expect(port("/configmaps").scrollTop).toBe(400);
  });
});
