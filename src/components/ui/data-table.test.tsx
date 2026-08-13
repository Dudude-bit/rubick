import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import type { ColumnDef } from "@tanstack/react-table";
import { Eye } from "lucide-react";

import { DataTable } from "./data-table";
import type { RowGrouping } from "./row-grouping";
import { RouteLink } from "./route-link";
import { TooltipProvider } from "./tooltip";
import { useScopeTabStore } from "@/stores/scopeTabStore";
import { useDisplaySettingsStore } from "@/stores/displaySettingsStore";

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

const pods = (count: number, namespaces = 1): Item[] =>
  Array.from({ length: count }, (_, index) => ({
    name: `pod-${index}`,
    namespace: namespaces === 1 ? "ns" : `ns-${index % namespaces}`,
  }));

const search = () => screen.getByLabelText("Search...");
const rowAt = (index: number) =>
  document.querySelector<HTMLElement>(`tr[data-row-index="${index}"]`);

// jsdom lays nothing out, so every box it reports is zero, and a virtualiser
// handed a zero-height scroll port concludes that the viewport holds no rows
// at all. These four are every measurement it takes.
//
// Row height comes from the density, because that is the whole of what a
// density change does to the geometry and nothing else tells the virtualiser
// about it. Neither number is the component's estimate for that density, on
// purpose: virtual-core only writes a measurement that differs from what it
// guessed, so rows that measure exactly the estimate leave the size cache
// empty and nothing that depends on a populated one can be tested at all.
const ROW_PX = { compact: 26, comfortable: 40 } as const;
const rowHeight = () => ROW_PX[useDisplaySettingsStore.getState().tableDensity];
const VIEWPORT_PX = 600;
const patched: (() => void)[] = [];
const stub = (proto: object, name: string, get: () => unknown) => {
  const original = Object.getOwnPropertyDescriptor(proto, name);
  Object.defineProperty(proto, name, { configurable: true, get });
  patched.push(() => {
    if (original) Object.defineProperty(proto, name, original);
    else delete (proto as Record<string, unknown>)[name];
  });
};

const layOutRows = () => {
  stub(HTMLElement.prototype, "offsetHeight", function (this: HTMLElement) {
    return this.tagName === "TR" ? rowHeight() : VIEWPORT_PX;
  });
  stub(Element.prototype, "clientHeight", () => VIEWPORT_PX);
  // As tall as whatever the virtualiser has put in the port: the rows it drew
  // plus the spacers standing in for the rest. A constant here clamps every
  // jump to a length the test invented, and a jump past that clamp lands
  // silently short — which is exactly the failure the caption case is about.
  stub(Element.prototype, "scrollHeight", function (this: Element) {
    let height = 0;
    this.querySelectorAll("tr").forEach((row) => {
      const declared = (row.firstElementChild as HTMLElement | null)?.style
        .height;
      height += declared ? Number.parseFloat(declared) : rowHeight();
    });
    return height;
  });
  // jsdom has no Element.scrollTo at all, and it is how the virtualiser
  // moves. Only the offset: the scroll event the browser would fire after
  // it is left to the test, so a reconcile cannot chase its own tail.
  Element.prototype.scrollTo = function (this: Element, options) {
    this.scrollTop = (options as ScrollToOptions)?.top ?? 0;
  } as Element["scrollTo"];
};

const stopLayingOutRows = () => {
  patched.splice(0).forEach((restore) => restore());
  delete (Element.prototype as Partial<Element>).scrollTo;
};

/** The scroll port only exists while the table is drawing a window of itself. */
const scrollPort = () =>
  document.querySelector<HTMLElement>('[style*="max-height"]');

// Density is a persisted store shared by the whole file, so a test that
// switches it would otherwise hand the next one a different table.
beforeEach(() => {
  useDisplaySettingsStore.setState({ tableDensity: "compact" });
});

describe("DataTable rows", () => {
  beforeEach(() => {
    useScopeTabStore.setState({
      tabs: [
        {
          id: "row-tab",
          context: null,
          namespace: "",
          scope: [],
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

describe("column widths", () => {
  const headers = () => screen.getAllByRole("columnheader");
  const widthOf = (name: string) =>
    screen.getByRole("columnheader", { name }).style.width;

  /**
   * The table is fixed-layout, and a fixed layout reads its whole grid from
   * the header row. Stop writing the sizes there and every column falls back
   * to TanStack's 150px default: a pod name gets exactly as much room as its
   * age, on every list in the app.
   */
  it("writes each column's declared size onto its header", () => {
    wrap(
      <DataTable<Item, unknown>
        columns={[
          { ...columns[0], size: 320 },
          { ...columns[1], size: 90 },
        ]}
        data={DATA}
      />
    );
    // Shares, not pixels: fixed layout resolves `width: 100%` as
    // `max(100%, sum of the widths)`, so declared pixels can only make the
    // table wider than the window, never narrower. 320 and 90 of a 410 total.
    expect(widthOf("Name")).toBe(`${(320 / 410) * 100}%`);
    expect(widthOf("Status")).toBe(`${(90 / 410) * 100}%`);
  });

  /**
   * The actions column is generated, so nobody was ever going to notice it
   * taking a name column's share of the table for two 20px icons — which is
   * what the default did, on every list that has quick actions at all.
   */
  it("sizes the generated actions column from what is in it", () => {
    const action = (label: string) => ({
      icon: Eye,
      label,
      onClick: () => {},
    });
    wrap(
      <DataTable<Item, unknown>
        columns={[{ ...columns[0], size: 320 }]}
        data={DATA}
        quickActions={[action("One")]}
      />
    );
    const share = () => Number.parseFloat(headers().at(-1)!.style.width);
    const nameShare = () => Number.parseFloat(headers()[0].style.width);
    const one = share();
    const oneName = nameShare();
    cleanup();

    wrap(
      <DataTable<Item, unknown>
        columns={[{ ...columns[0], size: 320 }]}
        data={DATA}
        quickActions={[action("One"), action("Two"), action("Three")]}
      />
    );
    const three = share();

    // Two icons' worth more room, and still a fraction of the name's — the
    // default handed it a full column's share for 20px of icons.
    expect(three).toBeGreaterThan(one);
    expect(one).toBeLessThan(oneName / 2);
  });
});

describe("the row's quick actions", () => {
  const withActions = () =>
    wrap(
      <DataTable<Item, unknown>
        columns={columns}
        data={DATA}
        quickActions={[{ icon: Eye, label: "View", onClick: () => {} }]}
      />
    );

  /**
   * The buttons are 20px so they fit a compact row's line box, and a
   * pseudo-element pushes the pointer target back out to 24px by hanging over
   * the cell's padding. A cell that clips takes that back: the real target in
   * the density the app opens on drops to 20×20, which is the size the button
   * was built not to be.
   */
  it("leaves the actions cell unclipped in compact density", () => {
    withActions();
    const actions = screen.getAllByLabelText("View")[0].closest("td");
    const name = screen.getByText("a-1").closest("td");

    expect(name?.className).toContain("overflow-hidden");
    expect(actions?.className).not.toContain("overflow-hidden");
  });

  /**
   * Revealed by CSS, and that is the point: the state-driven version
   * re-rendered every cell in the table each time the pointer crossed a row
   * boundary. On a list that also re-reads itself every two seconds the
   * columns visibly shifted under the pointer.
   */
  it("stay mounted and are hidden by the row's own hover state", () => {
    withActions();
    const button = screen.getAllByLabelText("View")[0];
    expect(button).toBeInTheDocument();

    const reveal = button.closest("div[class*='opacity-0']");
    expect(reveal?.className).toContain("group-hover:opacity-100");
    expect(reveal?.className).toContain("group-focus-within:opacity-100");
    // Keyboard focus counts as hover here, or the actions would be reachable
    // by pointer only.
    expect(reveal?.className).toContain(
      "group-data-[focused=true]:opacity-100"
    );
  });
});

describe("a list past the virtualisation threshold", () => {
  const many = pods(500);

  beforeEach(layOutRows);
  afterEach(stopLayingOutRows);

  const long = () =>
    wrap(
      <DataTable<Item, unknown>
        columns={columns}
        data={many}
        getRowHref={href}
        // Namespaces would caption every row into one group here; the flat
        // case is what the threshold is about.
        grouping={null}
      />
    );

  /**
   * Before this, "virtual scroll" was a max-height and an overflow: all 500
   * rows mounted, and a watch tick every two seconds re-rendered all of them.
   */
  it("mounts a window of rows rather than all of them", () => {
    long();
    const drawn = screen.getAllByRole("row").length;
    expect(drawn).toBeGreaterThan(1);
    expect(drawn).toBeLessThan(many.length / 4);
  });

  /** The rows that are not drawn are still held open, or the scrollbar lies. */
  it("keeps the undrawn rows' height in a spacer", () => {
    long();
    expect(
      document.querySelectorAll('tbody tr[aria-hidden="true"]').length
    ).toBeGreaterThan(0);
  });

  /**
   * End used to reach the last row by focusing it. Now the last row is not in
   * the DOM to be focused, so the table has to scroll it into existence first
   * — otherwise the keyboard reader is stranded at the top of a long list
   * while the scroll port jumps away underneath them.
   */
  it("carries a keyboard jump past the drawn window", () => {
    long();
    fireEvent.keyDown(rowAt(0)!, { key: "End" });
    fireEvent.scroll(scrollPort()!);

    expect(document.activeElement).toHaveAttribute("data-row-index", "499");
    expect(screen.getByText("pod-499")).toBeInTheDocument();
  });

  /**
   * The jump is aimed at a line, and captions are lines too. Aim it at the row
   * number instead and every caption above the target shifts the scroll short
   * by a row — fifty groups is two windows short, the row never mounts, and
   * End does nothing at all.
   */
  it("lands a keyboard jump on the right line when captions are drawn", () => {
    wrap(
      <DataTable<Item, unknown>
        columns={columns}
        data={pods(500, 50)}
        getRowHref={href}
        grouping={{
          keyOf: (row) => row.namespace,
          caption: (key, rows) => `${key} · ${rows.length}`,
        }}
      />
    );
    expect(screen.getByText("ns-0 · 10")).toBeInTheDocument();

    fireEvent.keyDown(rowAt(0)!, { key: "End" });
    fireEvent.scroll(scrollPort()!);

    expect(document.activeElement).toHaveAttribute("data-row-index", "499");
    expect(document.activeElement).toHaveTextContent("pod-499");
  });

  /**
   * The keyboard used to count to `data.length` while the table drew the rows
   * a search had left. End then aimed at row 499 of a list showing eleven,
   * found nothing to focus, and did nothing — silently.
   */
  it("sends End to the end of what the search left", async () => {
    long();
    fireEvent.change(search(), { target: { value: "pod-19" } });
    await waitFor(() =>
      expect(document.querySelectorAll("tr[data-row-index]")).toHaveLength(11)
    );

    fireEvent.keyDown(rowAt(0)!, { key: "End" });

    expect(document.activeElement).toHaveAttribute("data-row-index", "10");
    expect(document.activeElement).toHaveTextContent("pod-199");
  });

  /**
   * Same count, the other symptom: the stored index survived the search, no
   * drawn row matched it, and the table lost its focus ring and its only tab
   * stop until the reader pressed an arrow again.
   */
  it("keeps a focus ring and a tab stop after a search narrows the list", async () => {
    long();
    fireEvent.keyDown(rowAt(0)!, { key: "ArrowDown" });
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement).toHaveAttribute("data-row-index", "2");

    fireEvent.change(search(), { target: { value: "pod-499" } });
    await waitFor(() =>
      expect(document.querySelectorAll("tr[data-row-index]")).toHaveLength(1)
    );

    const focused = document.querySelector('tr[data-focused="true"]');
    expect(focused).toHaveAttribute("data-row-index", "0");
    expect(focused).toHaveAttribute("tabindex", "0");
  });

  /**
   * The tab stop rides on a row, and in a windowed table the row it is on can
   * be scrolled clean out of the DOM. Leave it there and the table has no
   * tabbable row at all: Tab skips the entire list, and a keyboard reader who
   * scrolled has no way back into it.
   */
  it("moves the tab stop into the window when its row scrolls out", () => {
    long();
    const port = scrollPort()!;
    port.scrollTop = 6000;
    fireEvent.scroll(port);

    expect(rowAt(0)).toBeNull();
    expect(
      document.querySelectorAll('tr[data-row-index][tabindex="0"]')
    ).toHaveLength(1);
  });

  /**
   * A jump names a row that is not drawn yet, and nothing guaranteed it ever
   * would be. Left unbounded, the index outlived the key press: a shorter list
   * never produced it, and the moment the list grew back the table took the
   * focus off whatever the reader had moved to since.
   */
  it("drops a jump whose row the list no longer has", () => {
    const tree = (data: Item[]) => (
      <MemoryRouter initialEntries={["/pods"]}>
        <TooltipProvider>
          <DataTable<Item, unknown>
            columns={columns}
            data={data}
            getRowHref={href}
            grouping={null}
          />
        </TooltipProvider>
      </MemoryRouter>
    );
    const { rerender } = render(tree(many));

    fireEvent.keyDown(rowAt(0)!, { key: "End" });
    // A watch tick shortens the list before the scroll has settled, then it
    // grows back past the row the jump named.
    rerender(tree(pods(200)));
    rerender(tree(many));
    fireEvent.scroll(scrollPort()!);

    expect(document.activeElement).toBe(document.body);
  });

  /**
   * A comfortable row is half again as tall, so fewer of them fit the port.
   * Nothing in virtual-core notices that on its own — heights are cached per
   * item and `estimateSize` is not part of what invalidates the cache — so
   * without the re-measure the window keeps drawing at the compact pitch: a
   * scrollbar off by the difference, and rows that jump as each one
   * re-measures on its way back in.
   */
  it("re-draws the window for the new row height when the density changes", () => {
    long();
    const drawn = () => document.querySelectorAll("tr[data-row-index]").length;
    const compact = drawn();

    act(() =>
      useDisplaySettingsStore.setState({ tableDensity: "comfortable" })
    );

    expect(drawn()).toBeLessThan(compact);
  });

  /** Windowing is a drawing decision. The list is still whole underneath it. */
  it("still counts the whole list", () => {
    long();
    expect(screen.getByText("500 rows")).toBeInTheDocument();
  });
});

describe("the size band the layout switches on", () => {
  const table = (count: number) => (
    <MemoryRouter initialEntries={["/pods"]}>
      <TooltipProvider>
        <DataTable<Item, unknown>
          columns={columns}
          data={pods(count)}
          grouping={null}
        />
      </TooltipProvider>
    </MemoryRouter>
  );

  /**
   * One threshold is a number that moves under the reader: a namespace sitting
   * at a hundred pods crossed it on a watch tick and crossed back on the next,
   * and the page snapped between a full-length table and a 600px box with its
   * own scrollbar — losing the scroll position every time, and throwing away
   * every measured row height with it.
   */
  it("holds its layout while the row count wobbles across the mark", () => {
    const { rerender } = render(table(120));
    expect(scrollPort()).not.toBeNull();

    rerender(table(98));
    expect(scrollPort()).not.toBeNull();
    rerender(table(120));
    expect(scrollPort()).not.toBeNull();

    // Genuinely a short list now, not a long one breathing.
    rerender(table(40));
    expect(scrollPort()).toBeNull();
  });
});
