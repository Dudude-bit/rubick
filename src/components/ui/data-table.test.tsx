import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import type { ColumnDef } from "@tanstack/react-table";
import { Eye } from "lucide-react";

import { DataTable } from "./data-table";
import type { RowGrouping } from "./row-grouping";
import { RouteLink } from "./route-link";
import { TooltipProvider } from "./tooltip";
import { useScopeTabStore } from "@/stores/scopeTabStore";

interface Item {
  name: string;
  namespace: string;
}

const DATA: Item[] = [
  { name: "a-1", namespace: "ns" },
  { name: "b-2", namespace: "ns" },
];

const href = (row: Item) => `/pods/${row.namespace}/${row.name}`;

const columns: ColumnDef<Item>[] = [
  {
    accessorKey: "name",
    header: "Name",
    cell: ({ row }) => (
      <RouteLink to={href(row.original)}>{row.original.name}</RouteLink>
    ),
  },
  {
    id: "status",
    header: "Status",
    cell: ({ row }) => (
      <span data-testid={`status-${row.original.name}`}>Running</span>
    ),
  },
];

function LocationProbe() {
  const { pathname } = useLocation();
  return <span data-testid="location">{pathname}</span>;
}

const wrap = (ui: ReactNode) =>
  render(
    <MemoryRouter initialEntries={["/pods"]}>
      <TooltipProvider>{ui}</TooltipProvider>
      <LocationProbe />
    </MemoryRouter>
  );

const location = () => screen.getByTestId("location").textContent;

/** Anywhere in the row that is not the name, a link or a quick action. */
const whitespace = () => screen.getByTestId("status-a-1");
const row = () => whitespace().closest("tr") as HTMLTableRowElement;

const middleClick = (element: Element) =>
  fireEvent(
    element,
    // Testing Library has no `auxClick` helper; React binds `onAuxClick` to
    // the native `auxclick` event, so dispatch that one.
    new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 })
  );

const tabs = () => useScopeTabStore.getState().tabs;
const isActive = (index: number) =>
  useScopeTabStore.getState().activeId === tabs()[index].id;

describe("DataTable rows", () => {
  beforeEach(() => {
    useScopeTabStore.setState({
      tabs: [
        {
          id: "row-tab",
          context: null,
          namespace: "",
          href: "/pods",
          missing: false,
        },
      ],
      activeId: "row-tab",
      pendingHref: null,
    });
  });

  const renderTable = (props?: { quickAction?: () => void }) =>
    wrap(
      <DataTable<Item, unknown>
        columns={columns}
        data={DATA}
        getRowHref={href}
        quickActions={
          props?.quickAction
            ? [{ icon: Eye, label: "View", onClick: props.quickAction }]
            : undefined
        }
      />
    );

  // A list is the page you are already browsing, so opening a row from it is
  // a drill-down, not a look-without-leaving. If this starts peeking, Back
  // stops being the way home from a list.
  it("navigates on a plain click anywhere in the row", () => {
    renderTable();
    fireEvent.click(whitespace());
    expect(location()).toBe("/pods/ns/a-1");
    expect(tabs()).toHaveLength(1);
  });

  // This is the regression the whole change exists for: the row used to call
  // navigate() unconditionally, so a modifier was swallowed and the reader
  // lost the page they asked to keep.
  it.each([
    ["ctrl", { ctrlKey: true }, true],
    ["meta", { metaKey: true }, true],
    ["shift", { shiftKey: true }, false],
  ])(
    "opens a %s click on the row in a scope tab, leaving the list alone",
    (_label, init, background) => {
      renderTable();
      fireEvent.click(whitespace(), init);
      expect(tabs()).toHaveLength(2);
      expect(tabs()[1].href).toBe("/pods/ns/a-1");
      expect(isActive(1)).toBe(!background);
      expect(location()).toBe("/pods");
    }
  );

  // Middle click did nothing at all on every list in the app.
  it("opens a middle click on the row behind the list", () => {
    renderTable();
    middleClick(whitespace());
    expect(tabs()).toHaveLength(2);
    expect(tabs()[1].href).toBe("/pods/ns/a-1");
    expect(isActive(0)).toBe(true);
    expect(location()).toBe("/pods");
  });

  // Alt-click is the platform's gesture; the row does not get to take it.
  it("leaves an alt click alone", () => {
    renderTable();
    fireEvent.click(whitespace(), { altKey: true });
    expect(tabs()).toHaveLength(1);
    expect(location()).toBe("/pods");
  });

  // A right click has to reach the context menu, and it arrives as auxclick
  // too — reading the modifiers before the button would eat it.
  it("ignores a right click, modified or not", () => {
    renderTable();
    fireEvent(
      whitespace(),
      new MouseEvent("auxclick", {
        bubbles: true,
        cancelable: true,
        button: 2,
        ctrlKey: true,
      })
    );
    expect(tabs()).toHaveLength(1);
    expect(location()).toBe("/pods");
  });

  it("keeps a quick action from opening the row", () => {
    const onClick = vi.fn();
    renderTable({ quickAction: onClick });
    fireEvent.click(screen.getAllByLabelText("View")[0]);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(location()).toBe("/pods");
    expect(tabs()).toHaveLength(1);
  });

  describe("keyboard", () => {
    it("opens the focused row on Enter", () => {
      renderTable();
      fireEvent.keyDown(row(), { key: "Enter" });
      expect(location()).toBe("/pods/ns/a-1");
    });

    // Enter is an activation like a click, so it carries the same modifiers.
    it("opens a modified Enter in a scope tab", () => {
      renderTable();
      fireEvent.keyDown(row(), { key: "Enter", ctrlKey: true });
      expect(tabs()).toHaveLength(2);
      expect(tabs()[1].href).toBe("/pods/ns/a-1");
      expect(location()).toBe("/pods");
    });

    it("still moves the focus with the arrows", () => {
      renderTable();
      fireEvent.keyDown(row(), { key: "ArrowDown" });
      expect(screen.getByTestId("status-b-2").closest("tr")).toHaveAttribute(
        "data-focused",
        "true"
      );
    });
  });

  describe("the name cell", () => {
    // No href meant no destination in the status bar, no "copy link address"
    // and no place in the keyboard's link order.
    it("is a real anchor carrying the row's destination", () => {
      renderTable();
      expect(screen.getByRole("link", { name: "a-1" })).toHaveAttribute(
        "href",
        "/pods/ns/a-1"
      );
    });

    // The row bails on anything inside an anchor, so a modified click on the
    // name must not also be handled by the row.
    it("opens exactly one tab when middle-clicked", () => {
      renderTable();
      middleClick(screen.getByRole("link", { name: "a-1" }));
      expect(tabs()).toHaveLength(2);
      expect(isActive(0)).toBe(true);
    });
  });
});

describe("row grouping", () => {
  const grouped = (
    data: Item[],
    grouping: RowGrouping<Item>,
    cols: ColumnDef<Item>[] = columns
  ) =>
    wrap(
      <DataTable<Item, unknown>
        columns={cols}
        data={data}
        grouping={grouping}
      />
    );

  const byLetter: RowGrouping<Item> = {
    keyOf: (row) => (row.name.startsWith("a") ? "the a pool" : null),
    caption: (key, rows) => `${key} · ${rows.length}`,
  };

  /**
   * The case that must not regress: a cluster where nothing carries the
   * grouping key gets exactly the table it had before grouping existed — no
   * captions, and above all no "ungrouped" heading, which would turn silence
   * into a claim.
   */
  it("draws a flat list when nothing states a group", () => {
    grouped(DATA, { keyOf: () => null, caption: () => "never" });
    expect(screen.getAllByRole("row")).toHaveLength(1 + DATA.length);
  });

  /** Namespaces ask for two groups; one pool still earns its caption. */
  it("honours a minimum before captioning anything", () => {
    grouped(DATA, { ...byLetter, keyOf: () => "one", minGroups: 2 });
    expect(screen.queryByText(/one/)).toBeNull();
    grouped(DATA, { ...byLetter, keyOf: () => "one" });
    expect(screen.getByText("one · 2")).toBeInTheDocument();
  });

  /**
   * A node the cloud says nothing about, sitting beside a managed pool, still
   * has to be reachable — and has to be drawn without being filed under a
   * group nobody stated.
   */
  it("draws rows with no group first and without a caption", () => {
    grouped(DATA, byLetter);
    const text = screen
      .getAllByRole("row")
      .map((tr) => tr.textContent ?? "")
      .filter((line) => line !== "");
    expect(text.filter((line) => line.includes("pool"))).toHaveLength(1);
    expect(text.findIndex((line) => line.includes("b-2"))).toBeLessThan(
      text.findIndex((line) => line.includes("the a pool"))
    );
  });

  /** A caption saying the same word on every row below it is one column of noise. */
  it("hides the column the caption has taken over", () => {
    const withNamespace: ColumnDef<Item>[] = [
      ...columns,
      { id: "namespace", header: "Namespace", cell: () => "ns" },
    ];
    grouped(
      DATA,
      { ...byLetter, keyOf: () => "one", hides: ["namespace"] },
      withNamespace
    );
    expect(screen.queryByText("Namespace")).toBeNull();
  });
});
