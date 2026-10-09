import { readFileSync } from "node:fs";
import { type ReactNode } from "react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import type { AnyRouter } from "@tanstack/react-router";
import type { ColumnDef } from "@/components/ui/table-features";
import { Eye } from "lucide-react";

import { actionsColumnSize } from "./column-shares";
import { buildTableRows } from "./data-table-rows";
import { DataTable } from "./data-table";
import type { RowGrouping } from "./row-grouping";
import { RouteLink } from "./route-link";
import { ResourceRef } from "@/components/object/ResourceRef";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./tooltip";
import { helmReleaseLink, hrefOf, objectLink } from "@/lib/links";
import { usePeek } from "@/hooks/usePeek";
import { renderWithRouter, settle } from "@/test/render";
import { useShortcuts } from "@/routes/c/$cluster/-shell/useShortcuts";
import { useScopeTabStore } from "@/stores/scopeTabStore";
import { useObjectMenuStore } from "@/stores/objectMenuStore";
import { useClusterStore } from "@/stores/clusterStore";
import { useDisplaySettingsStore } from "@/stores/displaySettingsStore";
import {
  ScreenShareProvider,
  useScreenSections,
} from "@/components/share/screen-share";

vi.mock("./data-table-rows", async (importOriginal) => {
  const original = await importOriginal<typeof import("./data-table-rows")>();
  return { ...original, buildTableRows: vi.fn(original.buildTableRows) };
});

interface Item {
  name: string;
  namespace: string;
}

const DATA: Item[] = [
  { name: "a-1", namespace: "ns" },
  { name: "b-2", namespace: "ns" },
];

const podLink = (row: Item) =>
  objectLink({ kind: "Pod", name: row.name, namespace: row.namespace })!;

const href = (row: Item) => hrefOf(podLink(row));

const columns: ColumnDef<Item>[] = [
  {
    accessorKey: "name",
    header: "Name",
    cell: ({ row }) => (
      <RouteLink {...podLink(row.original)}>{row.original.name}</RouteLink>
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
  const { pathname, searchStr } = useLocation();
  return <span data-testid="location">{`${pathname}${searchStr}`}</span>;
}

const LIST = "/c/prod/pods";

let router: AnyRouter;

const framed = (ui: ReactNode) => (
  <>
    <TooltipProvider>{ui}</TooltipProvider>
    <LocationProbe />
  </>
);

const wrap = async (ui: ReactNode, at = LIST) => {
  const rendered = await renderWithRouter(framed(ui), {
    at,
    route: "/c/$cluster/$",
  });
  router = rendered.router;
  return rendered;
};

const wrapRerenderable = async (initial: ReactNode) => {
  const rendered = await wrap(initial);
  return {
    ...rendered,
    rerender: (next: ReactNode) => rendered.rerender(framed(next)),
  };
};

const location = () => screen.getByTestId("location").textContent;

const goesTo = (expected: string) =>
  vi.waitFor(() => expect(location()).toBe(expected));

/** Lets a navigation that was started finish, so "nothing happened" means it. */
const staysAt = async (expected: string = LIST) => {
  await act(() => router.load());
  expect(location()).toBe(expected);
};

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
          href: LIST,
          missing: false,
        },
      ],
      activeId: "row-tab",
      pendingHref: null,
    });
  });

  const renderTable = (props?: { quickAction?: () => void }) =>
    wrap(
      <DataTable<Item>
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

  /**
   * The Helm releases row menu sat in a clipped cell, and the cell's ellipsis
   * drew a stray "..." beside the button. Fails if a column of controls is
   * clipped like text again, or if a text column stops ending in an ellipsis.
   */
  it("clips text cells with an ellipsis and leaves a row menu's cell alone", async () => {
    await wrap(
      <DataTable<Item>
        columns={[
          ...columns,
          {
            id: "actions",
            size: 50,
            cell: () => <button type="button">menu</button>,
          },
        ]}
        data={DATA}
        getRowHref={href}
      />
    );
    const menuCell = screen.getAllByText("menu")[0].closest("td");
    const statusCell = screen.getByTestId("status-a-1").closest("td");
    expect(menuCell).not.toHaveClass("text-ellipsis");
    expect(statusCell).toHaveClass("text-ellipsis");
  });

  /** The density switch is an icon alone; fails if a screen reader hears only "button" again. */
  it("names the density switch by what it switches to", async () => {
    await renderTable();
    expect(
      screen.getByRole("button", { name: /^(Compact|Comfortable) view$/ })
    ).toBeInTheDocument();
  });

  /**
   * Marco's greyed trash said why only over the left of its glyph: WebKitGTK's
   * overlay scrollbar takes a scrolling port's last 21px, and a pixel of hit
   * area hung below the last row made even a two-row list scroll. Fails if the
   * last button's cell gives up its gutter or the hit area outgrows the row.
   */
  it("keeps a row's last button clear of the scrollbar and its hit area inside the row", async () => {
    await renderTable({ quickAction: vi.fn() });
    const button = screen.getAllByRole("button", { name: "View" })[0];
    expect(button.closest("td")).toHaveStyle({ paddingRight: "24px" });
    expect(button.className).toContain("before:-inset-y-px");
    expect(button.className).not.toContain("before:-inset-0.5");
  });

  /**
   * The PVs list drew "k8s-gui-hostpath." with a stray dot: the storage
   * class link took its name's whole width, the cell clipped it, and the
   * cell's own ellipsis drew after it. Fails if a link that is a text cell's
   * whole content stops being bounded by the cell.
   */
  it("bounds a link that is a text cell's content by the cell", async () => {
    await wrap(
      <DataTable<Item>
        columns={[
          ...columns,
          {
            id: "storageClass",
            header: "Storage class",
            cell: () => (
              <ResourceRef
                kind="StorageClass"
                name="k8s-gui-hostpath"
                showKind={false}
              />
            ),
          },
        ]}
        data={DATA}
        getRowHref={href}
      />
    );
    const cell = screen
      .getAllByRole("link", { name: /k8s-gui-hostpath/ })[0]
      .closest("td");
    expect(cell?.firstElementChild?.tagName).toBe("A");
    expect(cell).toHaveClass("[&>a]:max-w-full", "text-ellipsis");
  });

  /**
   * A reference to a kind nothing routes is drawn as a span, which the cell
   * left its whole width, so its name was clipped with no ellipsis. Fails if
   * such a reference stops being bounded by the cell.
   */
  it("bounds a reference that is not a link by the cell as well", async () => {
    await wrap(
      <DataTable<Item>
        columns={[
          ...columns,
          {
            id: "release",
            header: "Release",
            cell: () => (
              <ResourceRef
                kind="HelmRelease"
                name="traefik"
                namespace="kube-system"
              />
            ),
          },
        ]}
        data={DATA}
        getRowHref={href}
      />
    );
    const cell = screen.getAllByTestId("resource-ref-name")[0].closest("td");
    expect(cell?.firstElementChild?.tagName).toBe("SPAN");
    expect(cell).toHaveClass("[&>span]:max-w-full");
  });

  /**
   * Issue #178: the name in a row peeked and the whitespace beside it went
   * to the page, and nobody could tell which they would get. Now both peek,
   * and the page is a double click. Would break if the row went back to
   * navigating on a plain click, or if the double click stopped opening it.
   */
  it("peeks on a plain click anywhere in the row, and opens the page on a double click", async () => {
    await renderTable();
    fireEvent.click(whitespace());
    await goesTo("/c/prod/pods?peek=pods%2Fns%2Fa-1");
    expect(tabs()).toHaveLength(1);
    fireEvent.doubleClick(whitespace());
    await goesTo("/c/prod/pods/ns/a-1");
  });

  /**
   * Sam clicked the row body in Ingresses and Services and nothing opened:
   * most of their cells ("1 path", the hosts, the status verdict) are
   * tooltip triggers, which are buttons, and the row left every button
   * alone. Fails if a cell that only shows a tooltip swallows the click
   * again, or if a real control inside a tooltip stops keeping its own.
   */
  it("peeks on a click on a cell that only shows a tooltip, and leaves a real control alone", async () => {
    const pressed = vi.fn();
    await wrap(
      <DataTable<Item>
        columns={[
          ...columns,
          {
            id: "paths",
            header: "Paths",
            cell: () => (
              <Tooltip>
                <TooltipTrigger>1 path</TooltipTrigger>
                <TooltipContent>/ to storefront:80</TooltipContent>
              </Tooltip>
            ),
          },
          {
            id: "copy",
            header: "Copy",
            cell: () => (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button type="button" onClick={pressed}>
                    copy
                  </button>
                </TooltipTrigger>
                <TooltipContent>Copy</TooltipContent>
              </Tooltip>
            ),
          },
        ]}
        data={DATA}
        getRowHref={href}
      />
    );
    fireEvent.click(screen.getAllByText("copy")[0]);
    expect(pressed).toHaveBeenCalledOnce();
    await staysAt();
    fireEvent.click(screen.getAllByText("1 path")[0]);
    await goesTo("/c/prod/pods?peek=pods%2Fns%2Fa-1");
  });

  /**
   * Sam clicked a cell the peek then slid over and its native tooltip
   * ("172.30.1.2") stayed drawn on top of the peek until the mouse moved.
   * Fails if the clicked cell keeps its title through the click, or never
   * gets it back once the pointer really moves.
   */
  it("holds the clicked cell's native tooltip back until the pointer moves", async () => {
    await wrap(
      <DataTable<Item>
        columns={[
          ...columns,
          {
            id: "ip",
            header: "IP",
            cell: ({ row }) => (
              <span data-testid={`ip-${row.original.name}`} title="172.30.1.2">
                172.30.1.2
              </span>
            ),
          },
        ]}
        data={DATA}
        getRowHref={href}
      />
    );
    const cell = screen.getByTestId("ip-a-1");
    fireEvent.click(cell, { clientX: 300, clientY: 40 });
    await goesTo("/c/prod/pods?peek=pods%2Fns%2Fa-1");
    expect(cell).not.toHaveAttribute("title");
    expect(screen.getByTestId("ip-b-2")).toHaveAttribute("title", "172.30.1.2");

    fireEvent.pointerMove(document.body, { clientX: 300, clientY: 40 });
    expect(cell).not.toHaveAttribute("title");
    fireEvent.pointerMove(document.body, { clientX: 340, clientY: 40 });
    expect(cell).toHaveAttribute("title", "172.30.1.2");
  });

  /**
   * The name is where the eye goes when told "double click the row", and it
   * is the one spot a `target.closest("a")` guard turned into nothing at
   * all: the whitespace opened the page and the name only peeked. A link
   * that points somewhere else — a row's node, its owner — keeps its own
   * meaning, because the reader aimed at that link rather than at the row.
   */
  it("opens the page on a double click on the row's own name, and not on a link elsewhere", async () => {
    await renderTable();
    fireEvent.doubleClick(screen.getByText("a-1"));
    await goesTo("/c/prod/pods/ns/a-1");
  });

  /**
   * The gutter the quick actions live in belongs to them: a single click
   * there is deliberately inert, and a double click navigated, so the same
   * spot answered two ways depending on how fast the reader clicked.
   */
  it("leaves the quick-actions gutter to the quick actions", async () => {
    const onClick = vi.fn();
    await renderTable({ quickAction: onClick });
    const gutter = row().querySelector("[data-quick-actions]") as HTMLElement;
    fireEvent.click(gutter);
    await staysAt();
    fireEvent.doubleClick(gutter);
    await staysAt();
  });

  it("leaves a double click on a link to somewhere else alone", async () => {
    await wrap(
      <DataTable<Item>
        columns={[
          {
            accessorKey: "name",
            header: "Name",
            cell: () => (
              <RouteLink {...objectLink({ kind: "Node", name: "worker-1" })!}>
                worker-1
              </RouteLink>
            ),
          },
        ]}
        data={[DATA[0]]}
        getRowHref={href}
      />
    );
    fireEvent.doubleClick(screen.getByText("worker-1"));
    await staysAt();
  });

  // A row whose route has no peek behind it is a plain link, as it always was.
  it("navigates on a plain click where the route is not an object", async () => {
    await wrap(
      <DataTable<Item>
        columns={columns}
        data={DATA}
        getRowHref={(row) =>
          hrefOf(
            helmReleaseLink({
              source: "native",
              namespace: row.namespace,
              name: row.name,
            })
          )
        }
      />
    );
    fireEvent.click(whitespace());
    await goesTo("/c/prod/helm/native/ns/a-1");
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
    async (_label, init, background) => {
      await renderTable();
      fireEvent.click(whitespace(), init);
      expect(tabs()).toHaveLength(2);
      expect(tabs()[1].href).toBe("/c/prod/pods/ns/a-1");
      expect(isActive(1)).toBe(!background);
      await staysAt();
    }
  );

  // Middle click did nothing at all on every list in the app.
  it("opens a middle click on the row behind the list", async () => {
    await renderTable();
    middleClick(whitespace());
    expect(tabs()).toHaveLength(2);
    expect(tabs()[1].href).toBe("/c/prod/pods/ns/a-1");
    expect(isActive(0)).toBe(true);
    await staysAt();
  });

  // Alt-click is the platform's gesture; the row does not get to take it.
  it("leaves an alt click alone", async () => {
    await renderTable();
    fireEvent.click(whitespace(), { altKey: true });
    expect(tabs()).toHaveLength(1);
    await staysAt();
  });

  // A right click has to reach the context menu, and it arrives as auxclick
  // too — reading the modifiers before the button would eat it.
  it("ignores a right click, modified or not", async () => {
    await renderTable();
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
    await staysAt();
  });

  it("keeps a quick action from opening the row", async () => {
    const onClick = vi.fn();
    await renderTable({ quickAction: onClick });
    fireEvent.click(screen.getAllByLabelText("View")[0]);
    expect(onClick).toHaveBeenCalledTimes(1);
    await staysAt();
    expect(tabs()).toHaveLength(1);
  });

  describe("keyboard", () => {
    /** Enter is the click's gesture: it peeks, and the peek's own Enter opens the page. */
    it("peeks at the focused row on Enter, as a click would", async () => {
      await renderTable();
      fireEvent.keyDown(row(), { key: "Enter" });
      await goesTo("/c/prod/pods?peek=pods%2Fns%2Fa-1");
    });

    // Enter is an activation like a click, so it carries the same modifiers.
    it("opens a modified Enter in a scope tab", async () => {
      await renderTable();
      fireEvent.keyDown(row(), { key: "Enter", ctrlKey: true });
      expect(tabs()).toHaveLength(2);
      expect(tabs()[1].href).toBe("/c/prod/pods/ns/a-1");
      await staysAt();
    });

    it("still moves the focus with the arrows", async () => {
      await renderTable();
      fireEvent.keyDown(row(), { key: "ArrowDown" });
      expect(screen.getByTestId("status-b-2").closest("tr")).toHaveAttribute(
        "aria-selected",
        "true"
      );
    });
  });

  describe("the name cell", () => {
    // No href meant no destination in the status bar, no "copy link address"
    // and no place in the keyboard's link order.
    it("is a real anchor carrying the row's destination", async () => {
      await renderTable();
      expect(screen.getByRole("link", { name: "a-1" })).toHaveAttribute(
        "href",
        "/c/prod/pods/ns/a-1"
      );
    });

    // The row bails on anything inside an anchor, so a modified click on the
    // name must not also be handled by the row.
    it("opens exactly one tab when middle-clicked", async () => {
      await renderTable();
      middleClick(screen.getByRole("link", { name: "a-1" }));
      expect(tabs()).toHaveLength(2);
      expect(isActive(0)).toBe(true);
    });
  });
});

function Shortcuts() {
  useShortcuts();
  return null;
}

describe("the list keys, from anywhere on a list page", () => {
  const page = (data: Item[] = DATA) => (
    <>
      <Shortcuts />
      <DataTable<Item>
        columns={columns}
        data={data}
        getRowHref={href}
        getRowId={(item) => item.name}
        grouping={null}
        pageKeys
      />
    </>
  );

  const press = (key: string, target: Element = document.body) =>
    fireEvent.keyDown(target, { key });

  const selected = () =>
    [...document.querySelectorAll('tr[aria-selected="true"]')].map(
      (row) => row.querySelector("a")?.textContent
    );

  const away = () => (document.activeElement as HTMLElement | null)?.blur();

  /** The footer promised arrows that did nothing until a row had been clicked. */
  it("selects the first row on the first arrow, with the focus on nothing", async () => {
    await wrap(page());
    expect(selected()).toEqual([]);
    press("ArrowDown");
    expect(selected()).toEqual(["a-1"]);
    expect(document.activeElement).toBe(rowAt(0));
  });

  /** Would break if j and k were not routed to the list after the chords. */
  it("walks with j and k as with the arrows", async () => {
    await wrap(page());
    press("j");
    away();
    press("j");
    expect(selected()).toEqual(["b-2"]);
    away();
    press("k");
    expect(selected()).toEqual(["a-1"]);
  });

  /** `g j` is the Jobs chord; its j must not also step the list. */
  it("leaves a chord's second key to the chord", async () => {
    await wrap(page());
    press("g");
    press("j");
    await goesTo("/c/prod/jobs");
  });

  /** Enter from the page is the row's click: the peek where the kind has one. */
  it("opens the selected row on Enter with the focus elsewhere", async () => {
    await wrap(page());
    press("ArrowDown");
    away();
    press("Enter");
    await goesTo("/c/prod/pods?peek=pods%2Fns%2Fa-1");
  });

  /** Whatever holds the focus owns its Enter; the row must not open underneath it. */
  it("leaves Enter to a focused control elsewhere on the page", async () => {
    await wrap(
      <>
        {page()}
        <div tabIndex={0} data-testid="elsewhere" />
      </>
    );
    press("ArrowDown");
    const elsewhere = screen.getByTestId("elsewhere");
    elsewhere.focus();
    press("Enter", elsewhere);
    await staysAt();
  });

  it("clears the selection on Escape", async () => {
    await wrap(page());
    press("ArrowDown");
    away();
    press("Escape");
    expect(selected()).toEqual([]);
  });

  /** Escape on the focused row clears it too, and lets go of the focus. */
  it("clears the selection on Escape from the row itself", async () => {
    await wrap(page());
    press("ArrowDown");
    press("Escape", rowAt(0)!);
    expect(selected()).toEqual([]);
    expect(document.activeElement).toBe(document.body);
  });

  it("puts the focus in the filter on /", async () => {
    await wrap(page());
    press("/");
    expect(document.activeElement).toBe(search());
  });

  /** A j typed into the filter is a letter; it must not step the list under it. */
  it("does not move the selection while the filter is being typed in", async () => {
    await wrap(page());
    press("ArrowDown");
    press("/");
    for (const key of ["j", "j"]) press(key, search());
    fireEvent.change(search(), { target: { value: "-" } });
    expect(selected()).toEqual(["a-1"]);
    expect(document.activeElement).toBe(search());
  });

  /** Down from the filter goes back into the rows; Escape just leaves the box. */
  it("leaves the filter for the rows on Down, and for the page on Escape", async () => {
    await wrap(page());
    press("/");
    press("Escape", search());
    expect(document.activeElement).toBe(document.body);
    press("/");
    press("ArrowDown", search());
    expect(document.activeElement).toBe(rowAt(0));
    expect(selected()).toEqual(["a-1"]);
  });

  /** Fails if Escape leaves the text in and the list narrowed. */
  it("empties the filter on the first Escape and leaves it on the second", async () => {
    await wrap(page());
    press("/");
    fireEvent.change(search(), { target: { value: "b-" } });
    await waitFor(() => expect(rowAt(1)).toBeFalsy());

    press("Escape", search());
    expect(search()).toHaveValue("");
    expect(document.activeElement).toBe(search());
    await waitFor(() => expect(rowAt(1)).toBeTruthy());

    press("Escape", search());
    expect(document.activeElement).toBe(document.body);
  });

  /**
   * Picking a namespace hands the focus back to its chip in the tab strip,
   * and j and Down did nothing there until a click. Fails if a horizontal
   * tab strip keeps the list's keys.
   */
  it("walks the list from a control in the tab strip", async () => {
    await wrap(
      <>
        <div role="tablist">
          <button type="button">shop</button>
        </div>
        {page()}
      </>
    );
    const chip = screen.getByRole("button", { name: "shop" });
    chip.focus();
    press("j", chip);
    expect(selected()).toEqual(["a-1"]);
    chip.focus();
    press("ArrowDown", chip);
    expect(selected()).toEqual(["b-2"]);
  });

  /**
   * A watch tick hands over new objects, and here a new pod sorts in above.
   * Tracked by position, the mark would slide onto a-1.
   */
  it("keeps the selection on the same object across a watch tick", async () => {
    const { rerender } = await wrapRerenderable(page());
    press("ArrowDown");
    press("ArrowDown", rowAt(0)!);
    expect(selected()).toEqual(["b-2"]);
    rerender(
      page([
        { name: "a-0", namespace: "ns" },
        ...DATA.map((item) => ({ ...item })),
      ])
    );
    expect(selected()).toEqual(["b-2"]);
  });

  /** A bare focus() scrolls every ancestor, the window included. */
  it("focuses a row without letting the browser scroll for it", async () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    await wrap(page());
    press("ArrowDown");
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    focus.mockRestore();
  });

  /** Only the page's own table answers from outside; an embedded one waits for focus. */
  it("leaves a table that is not the page's list alone", async () => {
    await wrap(
      <>
        <Shortcuts />
        <DataTable<Item> columns={columns} data={DATA} getRowHref={href} />
      </>
    );
    press("ArrowDown");
    expect(selected()).toEqual([]);
  });
});

describe("the row's menu", () => {
  afterEach(() => useObjectMenuStore.getState().close());

  const table = (
    onRowMenu: (row: Item, at: { x: number; y: number }) => void
  ) =>
    wrap(
      <>
        <Shortcuts />
        <DataTable<Item>
          columns={[
            ...columns,
            {
              id: "node",
              header: "Node",
              cell: () => (
                <RouteLink {...objectLink({ kind: "Node", name: "worker-1" })!}>
                  worker-1
                </RouteLink>
              ),
            },
          ]}
          data={DATA}
          getRowHref={href}
          grouping={null}
          pageKeys
          onRowMenu={onRowMenu}
        />
      </>
    );

  /** The webview's Back and Reload used to answer a right click on a row. */
  it("opens at the pointer on a right click anywhere in the row", async () => {
    const onRowMenu = vi.fn();
    await table(onRowMenu);
    const claimed = fireEvent.contextMenu(whitespace(), {
      clientX: 40,
      clientY: 50,
    });
    expect(claimed).toBe(false);
    expect(onRowMenu).toHaveBeenCalledWith(DATA[0], { x: 40, y: 50 });
    expect(row()).toHaveAttribute("aria-selected", "true");
  });

  /** The row's own name is the row; it must not open the thinner link menu instead. */
  it("opens the row's menu, not the link's, on the row's own name", async () => {
    const onRowMenu = vi.fn();
    await table(onRowMenu);
    fireEvent.contextMenu(screen.getByText("a-1"), { clientX: 1, clientY: 2 });
    expect(onRowMenu).toHaveBeenCalledTimes(1);
    expect(useObjectMenuStore.getState().target).toBeNull();
  });

  /** A link to another object is aimed at that object. */
  it("leaves a link to somewhere else its own menu", async () => {
    const onRowMenu = vi.fn();
    await table(onRowMenu);
    fireEvent.contextMenu(screen.getAllByText("worker-1")[0], {
      clientX: 1,
      clientY: 2,
    });
    expect(onRowMenu).not.toHaveBeenCalled();
    expect(useObjectMenuStore.getState().target?.name).toBe("worker-1");
  });

  /** The keyboard's way in: the Menu key on the focused row. */
  it("opens on the Menu key on the focused row", async () => {
    const onRowMenu = vi.fn();
    await table(onRowMenu);
    fireEvent.keyDown(rowAt(1)!, { key: "ContextMenu" });
    expect(onRowMenu).toHaveBeenCalledWith(DATA[1], { x: 0, y: 0 });
  });

  /** Shift+F10 from anywhere on the page, for the selected row. */
  it("opens on Shift+F10 for the selected row with the focus elsewhere", async () => {
    const onRowMenu = vi.fn();
    await table(onRowMenu);
    fireEvent.keyDown(document.body, { key: "ArrowDown" });
    (document.activeElement as HTMLElement).blur();
    fireEvent.keyDown(document.body, { key: "F10", shiftKey: true });
    expect(onRowMenu).toHaveBeenCalledWith(DATA[0], { x: 0, y: 0 });
  });
});

describe("row grouping", () => {
  const grouped = (
    data: Item[],
    grouping: RowGrouping<Item>,
    cols: ColumnDef<Item>[] = columns
  ) => wrap(<DataTable<Item> columns={cols} data={data} grouping={grouping} />);

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
  it("draws a flat list when nothing states a group", async () => {
    await grouped(DATA, { keyOf: () => null, caption: () => "never" });
    expect(screen.getAllByRole("row")).toHaveLength(1 + DATA.length);
  });

  /** Namespaces ask for two groups; one pool still earns its caption. */
  it("honours a minimum before captioning anything", async () => {
    await grouped(DATA, { ...byLetter, keyOf: () => "one", minGroups: 2 });
    expect(screen.queryByText(/one/)).toBeNull();
    await grouped(DATA, { ...byLetter, keyOf: () => "one" });
    expect(screen.getByText("one · 2")).toBeInTheDocument();
  });

  /**
   * A node the cloud says nothing about, sitting beside a managed pool, still
   * has to be reachable — and has to be drawn without being filed under a
   * group nobody stated.
   */
  it("draws rows with no group first and without a caption", async () => {
    await grouped(DATA, byLetter);
    const text = screen
      .getAllByRole("row")
      .map((tr) => tr.textContent ?? "")
      .filter((line) => line !== "");
    expect(text.filter((line) => line.includes("pool"))).toHaveLength(1);
    expect(text.findIndex((line) => line.includes("b-2"))).toBeLessThan(
      text.findIndex((line) => line.includes("the a pool"))
    );
  });

  /**
   * Marco's Deployments list put team-blind first on one visit and
   * team-checkout first on the next, in the order he had picked them. Fails
   * if the groups follow the order the rows arrived in.
   */
  it("draws the groups in name order, whatever order the rows arrive in", async () => {
    await grouped(
      [
        { name: "checkout-api", namespace: "team-checkout" },
        { name: "ledger", namespace: "team-blind" },
        { name: "checkout-worker", namespace: "team-checkout" },
      ],
      { keyOf: (row) => row.namespace, caption: (key) => `in ${key}` }
    );
    const lines = screen
      .getAllByRole("row")
      .slice(1)
      .map((tr) => tr.querySelector("td")?.textContent);
    expect(lines).toEqual([
      "in team-blind",
      "ledger",
      "in team-checkout",
      "checkout-api",
      "checkout-worker",
    ]);
  });

  /** A caption saying the same word on every row below it is one column of noise. */
  it("hides the column the caption has taken over", async () => {
    const withNamespace: ColumnDef<Item>[] = [
      ...columns,
      { id: "namespace", header: "Namespace", cell: () => "ns" },
    ];
    await grouped(
      DATA,
      { ...byLetter, keyOf: () => "one", hides: ["namespace"] },
      withNamespace
    );
    expect(screen.queryByText("Namespace")).toBeNull();
  });
});

/**
 * Nothing in the app puts a sort control on a header yet, so no other test
 * reaches this. It is pinned anyway because of *how* sorting is configured:
 * v9 resolves a column's `auto` sort function out of the `sortFns` registry
 * named in the feature set, and a registry that is missing or wrong makes
 * every column silently unsortable rather than failing anywhere. Without this
 * the day somebody adds a sort header is the day they find that out.
 */
describe("sorting a column", () => {
  const sortable: ColumnDef<Item>[] = [
    {
      accessorKey: "name",
      header: ({ column }) => (
        <button type="button" onClick={() => column.toggleSorting()}>
          Name
        </button>
      ),
      cell: ({ row }) => row.original.name,
    },
    columns[1],
  ];

  const namesInOrder = () =>
    screen
      .getAllByRole("row")
      .slice(1)
      .map((row) => row.querySelector("td")?.textContent);

  /** Equal sort values must preserve input order, including after an unrelated render. */
  it("preserves the input order of ties when sorting and rerendering", async () => {
    const data: Item[] = [
      { name: "b", namespace: "first" },
      { name: "a", namespace: "second" },
      { name: "b", namespace: "third" },
    ];
    const stableColumns: ColumnDef<Item>[] = [
      sortable[0],
      { accessorKey: "namespace", header: "Namespace" },
    ];
    const tree = () => <DataTable columns={stableColumns} data={data} />;
    const { rerender } = await wrapRerenderable(tree());
    const namespaces = () =>
      screen
        .getAllByRole("row")
        .slice(1)
        .map((row) => row.querySelectorAll("td")[1].textContent);
    fireEvent.click(screen.getByRole("button", { name: "Name" }));
    expect(namespaces()).toEqual(["second", "first", "third"]);
    fireEvent.click(screen.getByRole("button", { name: "Name" }));
    expect(namespaces()).toEqual(["first", "third", "second"]);
    rerender(tree());
    expect(namespaces()).toEqual(["first", "third", "second"]);
  });

  it("reverses the rows when its header is toggled twice", async () => {
    await wrap(<DataTable<Item> columns={sortable} data={DATA} />);
    expect(namesInOrder()).toEqual(["a-1", "b-2"]);

    fireEvent.click(screen.getByRole("button", { name: "Name" }));
    expect(namesInOrder()).toEqual(["a-1", "b-2"]);

    fireEvent.click(screen.getByRole("button", { name: "Name" }));
    expect(namesInOrder()).toEqual(["b-2", "a-1"]);
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
  it("writes each column's declared size onto its header", async () => {
    await wrap(
      <DataTable<Item>
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
   * A ClusterIP column's share of a 1160px table was 136px, and a 14-digit
   * address ended "10.111.219.1...". Fails if a column's floor stops reaching
   * its header once the table has been measured.
   */
  it("draws a column with a floor no narrower than the floor, once measured", async () => {
    const width = vi
      .spyOn(HTMLElement.prototype, "clientWidth", "get")
      .mockReturnValue(600);
    try {
      await wrap(
        <DataTable<Item>
          columns={[
            { ...columns[0], size: 500 },
            { ...columns[1], size: 100, meta: { floor: 300 } },
          ]}
          data={DATA}
        />
      );
      expect(widthOf("Status")).toBe("50%");
      expect(widthOf("Name")).toBe("50%");
    } finally {
      width.mockRestore();
    }
  });

  /**
   * Lena's Pods headers were cut to "Возр..." while other columns had room:
   * a header's share could be narrower than its label. Fails if a header's
   * words stop setting a floor under its column.
   */
  it("never draws a column narrower than its header's words, once measured", async () => {
    const width = vi
      .spyOn(HTMLElement.prototype, "clientWidth", "get")
      .mockReturnValue(400);
    try {
      await wrap(
        <DataTable<Item>
          columns={[
            { ...columns[0], size: 900 },
            { ...columns[1], header: "Перезапуски", size: 10 },
          ]}
          data={DATA}
        />
      );
      const floor = Math.ceil("Перезапуски".length * 6.8 + 20);
      expect(
        (Number.parseFloat(widthOf("Перезапуски")) / 100) * 400
      ).toBeGreaterThanOrEqual(floor);
    } finally {
      width.mockRestore();
    }
  });

  /**
   * Floors that add up to more than the port were drawn as per cent of a
   * table no wider than it, which cuts a column under its floor without a
   * scrollbar. Fails if the table stops being as wide as its floors when they
   * outgrow the port, or is widened when they fit.
   */
  it("is as wide as its floors when they outgrow the port, and no wider otherwise", async () => {
    const width = vi
      .spyOn(HTMLElement.prototype, "clientWidth", "get")
      .mockReturnValue(500);
    try {
      await wrap(
        <DataTable<Item>
          columns={[
            { ...columns[0], size: 300, meta: { floor: 300 } },
            { ...columns[1], size: 100, meta: { floor: 300 } },
          ]}
          data={DATA}
        />
      );
      expect(screen.getByRole("table").style.minWidth).toBe("600px");
      expect(widthOf("Name")).toBe("50%");
      expect(widthOf("Status")).toBe("50%");
    } finally {
      width.mockRestore();
    }
    const roomy = vi
      .spyOn(HTMLElement.prototype, "clientWidth", "get")
      .mockReturnValue(900);
    try {
      cleanup();
      await wrap(
        <DataTable<Item>
          columns={[
            { ...columns[0], size: 300, meta: { floor: 300 } },
            { ...columns[1], size: 100, meta: { floor: 300 } },
          ]}
          data={DATA}
        />
      );
      expect(screen.getByRole("table").style.minWidth).toBe("");
    } finally {
      roomy.mockRestore();
    }
  });

  /**
   * Lena read "v1.35...." for v1.35.5+k3s1: a floor written for the usual
   * value cannot know what a cluster says. Fails if a floor that reads the
   * rows is not handed every row the table holds.
   */
  it("hands a floor that reads the rows every row the table holds", async () => {
    const width = vi
      .spyOn(HTMLElement.prototype, "clientWidth", "get")
      .mockReturnValue(500);
    const byName = {
      ...columns[0],
      size: 300,
      meta: {
        floor: (_t: unknown, rows: readonly Item[]) =>
          Math.max(0, ...rows.map((row) => row.name.length * 100)),
      },
    };
    try {
      await wrap(
        <DataTable<Item>
          columns={[byName, { ...columns[1], size: 100 }]}
          data={[...DATA, { name: "long-one", namespace: "ns" }]}
        />
      );
      expect(screen.getByRole("table").style.minWidth).not.toBe("");
      expect(
        (Number.parseFloat(widthOf("Name")) / 100) *
          Number.parseFloat(screen.getByRole("table").style.minWidth)
      ).toBeGreaterThanOrEqual(800);
    } finally {
      width.mockRestore();
    }
  });

  /** Fails if the port is only measured on first render, which on every list that loads first left the floors unapplied and its headers cut. */
  it("applies its floors when the table arrives after the loading skeleton", async () => {
    const columnsOf = [
      { ...columns[0], size: 300, meta: { floor: 300 } },
      { ...columns[1], size: 100, meta: { floor: 300 } },
    ];
    const width = vi
      .spyOn(HTMLElement.prototype, "clientWidth", "get")
      .mockReturnValue(500);
    try {
      const { rerender } = await wrapRerenderable(
        <DataTable<Item> columns={columnsOf} data={[]} isLoading />
      );
      await act(async () => {
        rerender(<DataTable<Item> columns={columnsOf} data={DATA} />);
      });
      expect(screen.getByRole("table").style.minWidth).toBe("600px");
    } finally {
      width.mockRestore();
    }
  });

  /** Fails if the port's sideways scrollbar goes back to WebKit's overlay, opens mid-layout, or sits flush under the last row: Lena read the Nodes thumb as lying on the second row. */
  it("holds the sideways scrollbar in a lane of its own, only when the table scrolls", async () => {
    const columnsOf = [
      { ...columns[0], size: 300, meta: { floor: 300 } },
      { ...columns[1], size: 100, meta: { floor: 300 } },
    ];
    const port = () => screen.getByRole("table").parentElement!;
    const narrow = vi
      .spyOn(HTMLElement.prototype, "clientWidth", "get")
      .mockReturnValue(500);
    try {
      await wrap(<DataTable<Item> columns={columnsOf} data={DATA} />);
      expect(port().classList.contains("scrollbar-lane")).toBe(true);
      expect(port().style.overflowX).toBe("scroll");
      expect(port().style.paddingBottom).toBe("6px");
    } finally {
      narrow.mockRestore();
    }
    const roomy = vi
      .spyOn(HTMLElement.prototype, "clientWidth", "get")
      .mockReturnValue(900);
    try {
      cleanup();
      await wrap(<DataTable<Item> columns={columnsOf} data={DATA} />);
      expect(port().classList.contains("scrollbar-lane")).toBe(true);
      expect(port().style.overflowX).toBe("");
    } finally {
      roomy.mockRestore();
    }
  });

  /** Fails if a table that scrolls sideways lets its first column or group captions scroll away, which left no row saying which pod it was. */
  it("pins the first column and the group captions only while the table scrolls sideways", async () => {
    const columnsOf = [
      { ...columns[0], size: 300, meta: { floor: 300 } },
      { ...columns[1], size: 100, meta: { floor: 300 } },
    ];
    const grouping: RowGrouping<Item> = {
      keyOf: (item) => item.namespace,
      caption: (key) => `in ${key}`,
    };
    const pinned = () =>
      [...document.querySelectorAll("th, td")]
        .filter((cell) => cell.classList.contains("sticky"))
        .map((cell) => cell.textContent);
    const table = (
      <DataTable<Item> columns={columnsOf} data={DATA} grouping={grouping} />
    );
    const narrow = vi
      .spyOn(HTMLElement.prototype, "clientWidth", "get")
      .mockReturnValue(500);
    try {
      await wrap(table);
      expect(pinned()).toEqual(["Name", "a-1", "b-2"]);
      expect(screen.getByText("in ns").classList.contains("sticky")).toBe(true);
    } finally {
      narrow.mockRestore();
    }
    const roomy = vi
      .spyOn(HTMLElement.prototype, "clientWidth", "get")
      .mockReturnValue(900);
    try {
      cleanup();
      await wrap(table);
      expect(pinned()).toEqual([]);
      expect(screen.getByText("in ns").classList.contains("sticky")).toBe(
        false
      );
    } finally {
      roomy.mockRestore();
    }
  });

  /** Fails if a table cut at the port's edge gives no sign that columns continue, which left a header sliced to "A" unexplained. */
  it("shades the side where columns continue, and the pinned edge once scrolled", async () => {
    const columnsOf = [
      { ...columns[0], size: 300, meta: { floor: 300 } },
      { ...columns[1], size: 100, meta: { floor: 300 } },
    ];
    const edge = (side: string) =>
      document.querySelector(`[data-edge="${side}"]`);
    const width = vi
      .spyOn(HTMLElement.prototype, "clientWidth", "get")
      .mockReturnValue(500);
    const content = vi
      .spyOn(Element.prototype, "scrollWidth", "get")
      .mockReturnValue(600);
    try {
      await wrap(<DataTable<Item> columns={columnsOf} data={DATA} />);
      await waitFor(() => expect(edge("after")).not.toBeNull());
      expect(edge("before")).toBeNull();
      const port = screen.getByRole("table").parentElement!;
      port.scrollLeft = 100;
      fireEvent.scroll(port);
      await waitFor(() => expect(edge("before")).not.toBeNull());
      expect(edge("after")).toBeNull();
    } finally {
      width.mockRestore();
      content.mockRestore();
    }
  });

  /** Lena's light list faded grey text into a near-white canvas and the edge all but vanished; fails if either theme drops the shade the edges cast, or an edge stops casting it. */
  it("casts the same shade on the continuing side in the light theme as in the dark", async () => {
    const css = readFileSync("src/ui/index.css", "utf8");
    const folds = [...css.matchAll(/--fold: [^;]+\/ ([\d.]+);/g)].map((match) =>
      Number(match[1])
    );
    expect(folds).toHaveLength(2);
    for (const alpha of folds) expect(alpha).toBeGreaterThanOrEqual(0.1);
    const width = vi
      .spyOn(HTMLElement.prototype, "clientWidth", "get")
      .mockReturnValue(500);
    const content = vi
      .spyOn(Element.prototype, "scrollWidth", "get")
      .mockReturnValue(600);
    try {
      await wrap(
        <DataTable<Item>
          columns={[
            { ...columns[0], size: 300, meta: { floor: 300 } },
            { ...columns[1], size: 100, meta: { floor: 300 } },
          ]}
          data={DATA}
        />
      );
      await waitFor(() =>
        expect(document.querySelector('[data-edge="after"]')).not.toBeNull()
      );
      expect(
        document.querySelector('[data-edge="after"]')!.className
      ).toContain("var(--color-fold)");
    } finally {
      width.mockRestore();
      content.mockRestore();
    }
  });

  /** Fails if the lane's scrollbar takes a scrollbar-width or keeps the page's inherited scrollbar-color, which in WebKit both bring the overlay back. */
  it("styles the lane's scrollbar so WebKit draws it beside the rows, not over them", () => {
    const css = readFileSync("src/ui/index.css", "utf8");
    const start = css.indexOf("@utility scrollbar-lane {");
    const lane = css.slice(start, css.indexOf("\n}\n", start));
    expect(start).toBeGreaterThanOrEqual(0);
    expect(lane).toContain("scrollbar-color: auto;");
    expect(lane).not.toContain("scrollbar-width:");
    expect(lane).toContain("&::-webkit-scrollbar {");
    expect(lane).toContain("height: 8px;");
  });

  /**
   * A drag moves width from one column to the next; it does not add width.
   *
   * These tables are laid out in shares of their own width, and a dragged
   * column sits in its own denominator — so a drag that *added* pixels moved
   * the rendered edge by only a fraction of the travel, and the fraction
   * shrank as the drag went on. Holding the total still is what makes a
   * share move one-for-one with the pointer. Asserted on the shares, which
   * is the part jsdom can see; that the grip lands under the finger follows
   * from the total being constant.
   */
  it("takes the width a column gains from the one beside it", async () => {
    await wrap(
      <DataTable<Item>
        columns={[
          { ...columns[0], size: 300 },
          { ...columns[1], size: 200 },
        ]}
        data={DATA}
        rowLabel="items"
      />
    );
    const grip = document.querySelector<HTMLElement>(
      '[role="presentation"][title]'
    );
    expect(grip).not.toBeNull();

    const before = Number.parseFloat(widthOf("Name"));
    // Driven through `act` because the drag lives on `window`, outside
    // React's own event plumbing: without it the state update is scheduled
    // and the assertion reads the DOM before it lands.
    act(() => {
      fireEvent.pointerDown(grip!, { clientX: 0 });
      fireEvent(
        window,
        new MouseEvent("pointermove", { clientX: 40 } as MouseEventInit)
      );
      fireEvent(window, new MouseEvent("pointerup", {}));
    });

    await waitFor(() => {
      expect(Number.parseFloat(widthOf("Name"))).toBeGreaterThan(before);
    });
    // Percentages always add up to 100, so summing them proves nothing. What
    // the drag has to do is take from the neighbour: Name up by 40 of a 400
    // total is Status down by exactly the same 10 points.
    expect(Number.parseFloat(widthOf("Name"))).toBeCloseTo(
      ((300 + 40) / 500) * 100,
      5
    );
    expect(Number.parseFloat(widthOf("Status"))).toBeCloseTo(
      ((200 - 40) / 500) * 100,
      5
    );
  });

  /**
   * A column cannot be squeezed past the width of its own header word. Below
   * that it is a sliver whose label is cut — and before the floor existed,
   * the vendor's default of 20 let a drag paint one header over the next.
   */
  it("stops the neighbour at the narrowest a column may be", async () => {
    await wrap(
      <DataTable<Item>
        columns={[
          { ...columns[0], size: 300 },
          { ...columns[1], size: 200 },
        ]}
        data={DATA}
        rowLabel="clamped"
      />
    );
    const grip = document.querySelector<HTMLElement>(
      '[role="presentation"][title]'
    );
    act(() => {
      fireEvent.pointerDown(grip!, { clientX: 0 });
      fireEvent(
        window,
        new MouseEvent("pointermove", { clientX: 9999 } as MouseEventInit)
      );
      fireEvent(window, new MouseEvent("pointerup", {}));
    });
    // Everything it could take, and not the last 80 of it.
    expect(Number.parseFloat(widthOf("Name"))).toBeCloseTo(
      ((500 - 80) / 500) * 100,
      5
    );
  });

  /**
   * The conversion the whole rewrite exists for. A table is laid out in
   * shares, so one screen pixel is `total / width` of size — and jsdom
   * reports every clientWidth as 0, which sends the drag down the `: 1`
   * fallback. Every other test here therefore asserts raw pixel arithmetic
   * and stays green with the conversion deleted or inverted; this one stubs
   * the port's width so the arithmetic is the real one.
   */
  it("converts the pointer's travel through the width the table is drawn at", async () => {
    await wrap(
      <DataTable<Item>
        columns={[
          { ...columns[0], size: 300 },
          { ...columns[1], size: 200 },
        ]}
        data={DATA}
        rowLabel="converted"
      />
    );
    const port = document.querySelector("table")!.parentElement!;
    Object.defineProperty(port, "clientWidth", {
      value: 1000,
      configurable: true,
    });
    const grip = document.querySelector<HTMLElement>(
      '[role="presentation"][title]'
    );
    act(() => {
      fireEvent.pointerDown(grip!, { clientX: 0 });
      fireEvent(
        window,
        new MouseEvent("pointermove", { clientX: 40 } as MouseEventInit)
      );
      fireEvent(window, new MouseEvent("pointerup", {}));
    });
    // 500 units drawn across 1000px, so 40px of travel is 20 units — not 40.
    await waitFor(() => {
      expect(Number.parseFloat(widthOf("Name"))).toBeCloseTo(
        ((300 + 20) / 500) * 100,
        5
      );
    });
    expect(Number.parseFloat(widthOf("Status"))).toBeCloseTo(
      ((200 - 20) / 500) * 100,
      5
    );
  });

  /**
   * The live drag has to win over what is stored, or the header freezes
   * mid-drag and jumps on release. Every other test here drags once on a
   * table with nothing stored, so swapping the precedence to
   * `storedWidths ?? dragging` left them all green — while in the app every
   * drag after the first, on every list the reader has ever resized, gave no
   * feedback at all. The second drag is the whole point of this one.
   */
  it("follows the pointer on a second drag, after the first is stored", async () => {
    await wrap(
      <DataTable<Item>
        columns={[
          { ...columns[0], size: 300 },
          { ...columns[1], size: 200 },
        ]}
        data={DATA}
        rowLabel="twice"
      />
    );
    const grip = () =>
      document.querySelector<HTMLElement>('[role="presentation"][title]')!;

    act(() => {
      fireEvent.pointerDown(grip(), { clientX: 0 });
      fireEvent(
        window,
        new MouseEvent("pointermove", { clientX: 40 } as MouseEventInit)
      );
      fireEvent(window, new MouseEvent("pointerup", {}));
    });
    await waitFor(() => {
      expect(Number.parseFloat(widthOf("Name"))).toBeCloseTo(
        ((300 + 40) / 500) * 100,
        5
      );
    });

    // Asserted mid-drag, before the pointer is released: this is where the
    // stored width would win and the header would sit still.
    act(() => {
      fireEvent.pointerDown(grip(), { clientX: 0 });
      fireEvent(
        window,
        new MouseEvent("pointermove", { clientX: 30 } as MouseEventInit)
      );
    });
    await waitFor(() => {
      expect(Number.parseFloat(widthOf("Name"))).toBeCloseTo(
        ((340 + 30) / 500) * 100,
        5
      );
    });
    act(() => {
      fireEvent(window, new MouseEvent("pointerup", {}));
    });
  });

  /**
   * A column narrower than the floor is narrow on purpose — the generated
   * actions strip is 64 units for two icons. Clamping it up to 80 made the
   * first pixel of any drag inflate it and narrow its neighbour, in a
   * direction nobody dragged and which could never be given back.
   */
  it("leaves a column already narrower than the floor where it was", async () => {
    await wrap(
      <DataTable<Item>
        columns={[
          { ...columns[0], size: 300 },
          { ...columns[1], size: 64 },
        ]}
        data={DATA}
        rowLabel="narrow"
      />
    );
    const grip = document.querySelector<HTMLElement>(
      '[role="presentation"][title]'
    );
    const before = Number.parseFloat(widthOf("Status"));
    act(() => {
      fireEvent.pointerDown(grip!, { clientX: 0 });
      fireEvent(
        window,
        new MouseEvent("pointermove", { clientX: 0 } as MouseEventInit)
      );
      fireEvent(window, new MouseEvent("pointerup", {}));
    });
    await waitFor(() => {
      expect(Number.parseFloat(widthOf("Status"))).toBeCloseTo(before, 5);
    });
    expect(Number.parseFloat(widthOf("Name"))).toBeCloseTo(
      (300 / 364) * 100,
      5
    );
  });

  /**
   * A right-click on the grip used to start a drag, and the context menu
   * then ate the pointerup that would have ended it — so the table went on
   * resizing itself under a pointer nobody was holding down.
   */
  it("does not start a drag on any button but the first", async () => {
    await wrap(
      <DataTable<Item>
        columns={[
          { ...columns[0], size: 300 },
          { ...columns[1], size: 200 },
        ]}
        data={DATA}
        rowLabel="right-clicked"
      />
    );
    const grip = document.querySelector<HTMLElement>(
      '[role="presentation"][title]'
    );
    const before = widthOf("Name");
    act(() => {
      fireEvent.pointerDown(grip!, { clientX: 0, button: 2 });
      fireEvent(
        window,
        new MouseEvent("pointermove", { clientX: 120 } as MouseEventInit)
      );
    });
    expect(widthOf("Name")).toBe(before);
  });

  /**
   * Double-click is the only way back to the declared widths, and the store
   * keeps what a drag wrote — so without it a table dragged once is dragged
   * for good, on every visit, with nothing in the UI saying so.
   */
  it("puts both columns back to their declared widths on a double click", async () => {
    await wrap(
      <DataTable<Item>
        columns={[
          { ...columns[0], size: 300 },
          { ...columns[1], size: 200 },
        ]}
        data={DATA}
        rowLabel="reset"
      />
    );
    const grip = document.querySelector<HTMLElement>(
      '[role="presentation"][title]'
    );
    const declared = widthOf("Name");
    act(() => {
      fireEvent.pointerDown(grip!, { clientX: 0 });
      fireEvent(
        window,
        new MouseEvent("pointermove", { clientX: 40 } as MouseEventInit)
      );
      fireEvent(window, new MouseEvent("pointerup", {}));
    });
    await waitFor(() => {
      expect(widthOf("Name")).not.toBe(declared);
    });
    act(() => {
      fireEvent.doubleClick(grip!);
    });
    await waitFor(() => {
      expect(widthOf("Name")).toBe(declared);
    });
  });

  /**
   * The last column's right edge is the table's own, and there is nothing to
   * its right to take width from. A grip there could not move anything — and
   * the one that used to be there straddled the edge, giving every list in
   * the app a few pixels of horizontal scroll it never had.
   */
  it("puts no grip on the last column", async () => {
    await wrap(
      <DataTable<Item>
        columns={[
          { ...columns[0], size: 300 },
          { ...columns[1], size: 100 },
        ]}
        data={DATA}
      />
    );
    const grips = document.querySelectorAll('[role="presentation"][title]');
    expect(grips).toHaveLength(headers().length - 1);
  });

  /**
   * The actions column is generated, so nobody was ever going to notice it
   * taking a name column's share of the table for two 20px icons — which is
   * what the default did, on every list that has quick actions at all.
   */
  /**
   * Scrolled to the end, Lena's Pods showed a stray ")" of a restart count
   * beside the pinned Name. Fails if a table ends its sideways scroll on a
   * sliver of a column, or hands that sliver's width to the row's buttons.
   */
  it("ends a sideways scroll on whole columns, the buttons at their own width", async () => {
    const width = vi
      .spyOn(HTMLElement.prototype, "clientWidth", "get")
      .mockReturnValue(500);
    try {
      await wrap(
        <DataTable<Item>
          columns={[
            { ...columns[0], size: 300, meta: { floor: 300 } },
            { ...columns[1], size: 100, meta: { floor: 150 } },
            {
              id: "age",
              header: "Age",
              size: 80,
              meta: { floor: 100 },
              cell: () => "1m",
            },
          ]}
          data={DATA}
          quickActions={[{ icon: Eye, label: "Look", onClick: () => {} }]}
        />
      );
      const span = Number.parseFloat(screen.getByRole("table").style.minWidth);
      const px = headers().map(
        (header) => (Number.parseFloat(header.style.width) / 100) * span
      );
      expect(px[2] + px[3]).toBeCloseTo(500 - 300);
      expect(px[3]).toBeCloseTo(actionsColumnSize(1));
    } finally {
      width.mockRestore();
    }
  });

  it("sizes the generated actions column from what is in it", async () => {
    const action = (label: string) => ({
      icon: Eye,
      label,
      onClick: () => {},
    });
    await wrap(
      <DataTable<Item>
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

    await wrap(
      <DataTable<Item>
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
      <DataTable<Item>
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
  it("leaves the actions cell unclipped in compact density", async () => {
    await withActions();
    const actions = screen.getAllByLabelText("View")[0].closest("td");
    const name = screen.getByText("a-1").closest("td");

    expect(name?.className).toContain("overflow-hidden");
    expect(actions?.className).not.toContain("overflow-hidden");
  });

  /**
   * Clipping is about the layout being fixed, not about the density. It was
   * written as `isCompact && ...`, so on comfortable — a real setting — a
   * column dragged to its floor painted its text straight over the column
   * beside it, which is the one thing fixed layout was chosen to prevent.
   */
  it("clips a text cell in comfortable density too", async () => {
    act(() =>
      useDisplaySettingsStore.setState({ tableDensity: "comfortable" })
    );
    await withActions();
    const name = screen.getByText("a-1").closest("td");
    const actions = screen.getAllByLabelText("View")[0].closest("td");

    expect(name?.className).toContain("overflow-hidden");
    // Still not the actions cell: clipping it clips the buttons' hit area.
    expect(actions?.className).not.toContain("overflow-hidden");
  });

  /**
   * Dana scrolled the Events table past Age into a blank band: a span
   * positioned for screen readers far along a cut message was held by the
   * port, not by the cell clipping it, and the port grew to reach it. Fails
   * if a clipped cell is not the box its positioned contents are held in.
   */
  it("holds what is positioned inside a clipped cell within that cell, pinned or not", async () => {
    const positioned = /\b(relative|sticky)\b/;
    await withActions();
    expect(screen.getByText("a-1").closest("td")?.className).toMatch(
      positioned
    );
    cleanup();
    const narrow = vi
      .spyOn(HTMLElement.prototype, "clientWidth", "get")
      .mockReturnValue(200);
    try {
      await wrap(
        <DataTable<Item>
          columns={[
            { ...columns[0], size: 300, meta: { floor: 300 } },
            { ...columns[1], size: 100, meta: { floor: 300 } },
          ]}
          data={DATA}
        />
      );
      for (const cell of document.querySelectorAll("td"))
        expect(cell.className).toMatch(positioned);
      expect(screen.getByText("a-1").closest("td")).toHaveClass("sticky");
    } finally {
      narrow.mockRestore();
    }
  });

  /**
   * Revealed by CSS, and that is the point: the state-driven version
   * re-rendered every cell in the table each time the pointer crossed a row
   * boundary. On a list that also re-reads itself every two seconds the
   * columns visibly shifted under the pointer.
   */
  it("stay mounted and are hidden by the row's own hover state", async () => {
    await withActions();
    const button = screen.getAllByLabelText("View")[0];
    expect(button).toBeInTheDocument();

    const reveal = button.closest("div[class*='opacity-0']");
    expect(reveal?.className).toContain("group-hover:opacity-100");
    expect(reveal?.className).toContain("group-focus-within:opacity-100");
    // Keyboard focus counts as hover here, or the actions would be reachable
    // by pointer only.
    expect(reveal?.className).toContain("group-aria-selected:opacity-100");
  });

  /**
   * The bug this is about: on the Pods page the buttons did nothing to a
   * single click, and a few clicks anywhere in the row opened the pod.
   *
   * `flexRender` calls a cell renderer *as a component*, so a renderer built
   * fresh on each render is a new element type and React unmounts and remounts
   * the whole cell. The list re-reads itself every two seconds — metrics alone
   * differ on every read — so the button under the pointer was replaced by a
   * different DOM node between `mousedown` and `mouseup`, and no `click` was
   * ever raised. The row's own handler, bound to a `tr` that does survive,
   * kept working, which is why pressing repeatedly navigated instead.
   */
  it("keeps the same button across a re-render", async () => {
    const table = () => (
      <DataTable<Item>
        columns={columns}
        data={DATA}
        getRowHref={href}
        // A fresh array every render, exactly as `ResourceList` builds it
        // from the page's `quickActions` factory.
        quickActions={[{ icon: Eye, label: "View", onClick: () => {} }]}
      />
    );
    const { rerender } = await wrapRerenderable(table());
    const before = screen.getAllByLabelText("View")[0];

    rerender(table());

    expect(screen.getAllByLabelText("View")[0]).toBe(before);
  });
});

describe("what a re-render costs", () => {
  let drawn = 0;
  function CountedName({ row }: { row: { original: Item } }) {
    drawn += 1;
    return <span>{row.original.name}</span>;
  }
  const counted: ColumnDef<Item>[] = [
    { id: "name", header: "Name", cell: CountedName },
  ];
  const items = Array.from({ length: 40 }, (_, index) => ({
    name: `pod-${index}`,
    namespace: "ns",
  }));
  const table = (data: Item[]) => (
    <DataTable<Item> columns={counted} data={data} getRowHref={href} />
  );

  beforeEach(() => {
    drawn = 0;
  });

  /**
   * Every list re-reads itself on a timer, and during an outage each failed
   * read re-renders the page with the same rows. Drawing all of them again
   * for each was the climb in UI stalls on a 73-row Pods list with no input.
   */
  it("draws only the row whose object changed when the table renders again", async () => {
    const { rerender } = await wrapRerenderable(table(items));
    drawn = 0;

    rerender(table([...items]));
    expect(drawn).toBe(0);

    rerender(table(items.map((item, i) => (i === 3 ? { ...item } : item))));
    expect(drawn).toBe(1);
  });

  /**
   * A newest-first feed puts each new row on top and moves every other one
   * place down. Fails if a row that only moved draws its cells again.
   */
  it("draws only the new row's cells when a row arrives on top", async () => {
    const keyed = (data: Item[]) => (
      <DataTable<Item>
        columns={counted}
        data={data}
        getRowHref={href}
        getRowId={(item) => item.name}
      />
    );
    const { rerender } = await wrapRerenderable(keyed(items));
    drawn = 0;

    rerender(keyed([{ name: "pod-new", namespace: "ns" }, ...items]));

    expect(drawn).toBe(1);
  });

  /** The density toggle restyled the rows by drawing every one of them again. */
  it("restyles the rows on a density switch without drawing them again", async () => {
    await wrap(table(items));
    drawn = 0;

    act(() =>
      useDisplaySettingsStore.setState({ tableDensity: "comfortable" })
    );

    expect(drawn).toBe(0);
    expect(document.querySelector("table")?.dataset.density).toBe(
      "comfortable"
    );
  });
});

describe("a list past the virtualisation threshold", () => {
  const many = pods(500);

  beforeEach(layOutRows);
  afterEach(stopLayingOutRows);

  const long = () =>
    wrap(
      <DataTable<Item>
        columns={columns}
        data={many}
        getRowHref={href}
        // Namespaces would caption every row into one group here; the flat
        // case is what the threshold is about.
        grouping={null}
      />
    );

  /**
   * Lena read "141 rows. Narrow the scope or search" in warning colour over
   * exactly the 141 warnings kubectl listed: nothing was missing. Fails if a
   * whole long list is drawn as a warning, or a list cut at a limit is not.
   */
  it("advises on a whole long list and warns only where the read stopped at a limit", async () => {
    await long();
    const advice = screen.getByText(
      "500 rows. To trim the list, narrow the scope or search"
    );
    expect(advice.closest(".text-warn")).toBeNull();
    expect(advice.parentElement?.querySelector(".text-warn")).toBeNull();
    cleanup();

    await wrap(
      <DataTable<Item>
        columns={columns}
        data={many}
        getRowHref={href}
        grouping={null}
        cutAt={500}
      />
    );
    const cut = screen.getByText(
      "Only the latest 500 were read. To see older ones, narrow the scope or raise the limit"
    );
    expect(cut.parentElement?.querySelector("svg")).toHaveClass("text-warn");
    expect(screen.queryByText(/To trim the list/)).toBeNull();
  });

  /** Rebuilding descriptors or sorting on scroll makes windowing cost the entire list. */
  it.each([false, true])(
    "reuses descriptors and navigation indexes when the scroll offset changes with grouping %s",
    async (grouped) => {
      const sortFn = vi.fn((a: { original: Item }, b: { original: Item }) =>
        a.original.name.localeCompare(b.original.name)
      );
      const sortable: ColumnDef<Item>[] = [
        {
          accessorKey: "name",
          header: ({ column }) => (
            <button onClick={() => column.toggleSorting()}>Sort</button>
          ),
          cell: ({ row }) => row.original.name,
          sortFn,
        },
      ];
      await wrap(
        <DataTable
          columns={sortable}
          data={pods(10_000)}
          getRowHref={href}
          grouping={
            grouped
              ? { keyOf: (row) => row.namespace, caption: (key) => key }
              : null
          }
        />
      );
      fireEvent.click(screen.getByRole("button", { name: "Sort" }));
      expect(sortFn).toHaveBeenCalled();
      const builder = vi.mocked(buildTableRows);
      const before = builder.mock.results.at(-1)!.value;
      builder.mockClear();
      sortFn.mockClear();

      const port = scrollPort()!;
      port.scrollTop = 6000;
      fireEvent.scroll(port);

      expect(rowAt(0)).toBeNull();
      expect(
        document.querySelectorAll("tr[data-row-index]").length
      ).toBeGreaterThan(0);
      expect(builder).not.toHaveBeenCalled();
      expect(sortFn).not.toHaveBeenCalled();
      expect(before.rowLine).toHaveLength(10_000);
    }
  );

  /** Stale line indexes after sorting send a virtual keyboard jump to another row. */
  it("moves the keyboard through the visible grouped order after sorting", async () => {
    const sortable: ColumnDef<Item>[] = [
      {
        accessorKey: "name",
        sortFn: (a, b) =>
          a.original.name.localeCompare(b.original.name, undefined, {
            numeric: true,
          }),
        header: ({ column }) => (
          <button onClick={() => column.toggleSorting()}>Sort</button>
        ),
        cell: ({ row }) => row.original.name,
      },
    ];
    await wrap(
      <DataTable
        columns={sortable}
        data={pods(500, 50)}
        getRowHref={href}
        grouping={{ keyOf: (row) => row.namespace, caption: (key) => key }}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Sort" }));
    fireEvent.click(screen.getByRole("button", { name: "Sort" }));
    expect(rowAt(0)).toHaveTextContent(/^pod-450$/);
    fireEvent.keyDown(rowAt(0)!, { key: "ArrowDown" });
    expect(document.activeElement).toHaveTextContent(/^pod-400$/);
    expect(document.activeElement).toHaveAttribute("data-row-index", "1");
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    fireEvent.scroll(scrollPort()!);
    expect(document.activeElement).toHaveTextContent(/^pod-49$/);
    expect(document.activeElement).toHaveAttribute("data-row-index", "499");
  });

  /**
   * Before this, "virtual scroll" was a max-height and an overflow: all 500
   * rows mounted, and a watch tick every two seconds re-rendered all of them.
   */
  it("mounts a window of rows rather than all of them", async () => {
    await long();
    const drawn = screen.getAllByRole("row").length;
    expect(drawn).toBeGreaterThan(1);
    expect(drawn).toBeLessThan(many.length / 4);
  });

  /** The rows that are not drawn are still held open, or the scrollbar lies. */
  it("keeps the undrawn rows' height in a spacer", async () => {
    await long();
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
  it("carries a keyboard jump past the drawn window", async () => {
    await long();
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
  it("lands a keyboard jump on the right line when captions are drawn", async () => {
    await wrap(
      <DataTable<Item>
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
  /**
   * The box reaches every column a reader can see, not only the name.
   *
   * Ten lists used to aim it at one column, and searching an Ingress by the
   * hostname it serves — or a StorageClass by its provisioner — found
   * nothing. Fails if a second road back to a single column returns.
   */
  /**
   * A column holding a structure is searched by the text it shows.
   *
   * An accessor over an array of objects stringifies to `[object Object]`,
   * so the box matched nothing on it and "object" matched every row. The
   * Ingress hosts column, which is the one people open that page to read,
   * was one. Fails if such a column goes back to a bare `accessorKey`.
   */
  it("matches a column whose value is a structure by what it shows", async () => {
    await wrap(
      <DataTable
        columns={[
          ...columns,
          {
            id: "hosts",
            accessorFn: (row: Item & { hosts?: string[] }) =>
              (row.hosts ?? []).join(" "),
            header: "Hosts",
          },
        ]}
        data={[
          { name: "a-1", namespace: "ns", hosts: ["legacy.nginx.test"] },
          { name: "b-2", namespace: "ns", hosts: ["checkout.test"] },
        ]}
        getRowHref={href}
      />
    );

    fireEvent.change(search(), { target: { value: "legacy.nginx" } });
    await waitFor(() => expect(screen.queryByText("b-2")).toBeNull());
    expect(screen.getByText("a-1")).toBeInTheDocument();
  });

  it("matches on a column other than the first", async () => {
    await wrap(
      <DataTable
        columns={[
          ...columns,
          { accessorKey: "namespace", header: "Namespace" },
        ]}
        data={[
          { name: "orders-api", namespace: "payments" },
          { name: "billing-worker", namespace: "shop" },
        ]}
        getRowHref={href}
      />
    );
    expect(screen.getByText("billing-worker")).toBeInTheDocument();

    fireEvent.change(search(), { target: { value: "payments" } });
    await waitFor(() =>
      expect(screen.queryByText("billing-worker")).toBeNull()
    );
    expect(screen.getByText("orders-api")).toBeInTheDocument();
  });

  it("sends End to the end of what the search left", async () => {
    await long();
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
  it("keeps a focus ring-3 and a tab stop after a search narrows the list", async () => {
    await long();
    fireEvent.keyDown(rowAt(0)!, { key: "ArrowDown" });
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement).toHaveAttribute("data-row-index", "2");

    fireEvent.change(search(), { target: { value: "pod-499" } });
    await waitFor(() =>
      expect(document.querySelectorAll("tr[data-row-index]")).toHaveLength(1)
    );

    const focused = document.querySelector('tr[aria-selected="true"]');
    expect(focused).toHaveAttribute("data-row-index", "0");
    expect(focused).toHaveAttribute("tabindex", "0");
  });

  /**
   * The tab stop rides on a row, and in a windowed table the row it is on can
   * be scrolled clean out of the DOM. Leave it there and the table has no
   * tabbable row at all: Tab skips the entire list, and a keyboard reader who
   * scrolled has no way back into it.
   */
  it("moves the tab stop into the window when its row scrolls out", async () => {
    await long();
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
  it("drops a jump whose row the list no longer has", async () => {
    const tree = (data: Item[]) => (
      <DataTable<Item>
        columns={columns}
        data={data}
        getRowHref={href}
        grouping={null}
      />
    );
    const { rerender } = await wrapRerenderable(tree(many));

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
  it("re-draws the window for the new row height when the density changes", async () => {
    await long();
    const drawn = () => document.querySelectorAll("tr[data-row-index]").length;
    const compact = drawn();

    act(() =>
      useDisplaySettingsStore.setState({ tableDensity: "comfortable" })
    );

    expect(drawn()).toBeLessThan(compact);
  });

  /** Windowing is a drawing decision. The list is still whole underneath it. */
  it("still counts the whole list", async () => {
    await long();
    expect(screen.getByText("500 rows")).toBeInTheDocument();
  });
});

describe("the size band the layout switches on", () => {
  const table = (count: number) => (
    <DataTable<Item> columns={columns} data={pods(count)} grouping={null} />
  );

  /**
   * One threshold is a number that moves under the reader: a namespace sitting
   * at a hundred pods crossed it on a watch tick and crossed back on the next,
   * and the page snapped between a full-length table and a 600px box with its
   * own scrollbar — losing the scroll position every time, and throwing away
   * every measured row height with it.
   */
  it("holds its layout while the row count wobbles across the mark", async () => {
    const { rerender } = await wrapRerenderable(table(120));
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

/**
 * The bug this is about: a Pods page at 105 rows drew a 600px table and left
 * the rest of a 1000px window blank under it, count row and all. The number
 * was a constant, so the taller the display the more of it was nothing.
 */
describe("a table given the page's height", () => {
  beforeEach(layOutRows);
  afterEach(stopLayingOutRows);

  const filled = (count: number) =>
    wrap(
      <DataTable<Item>
        columns={columns}
        data={pods(count)}
        fill
        rowLabel="pods"
        grouping={null}
      />
    );

  /** A filled table's scroll port carries no inline height to find it by. */
  const port = () => document.querySelector("table")!.parentElement!;

  /** The pane it is in, not a number written here. */
  it("takes no fixed height of its own", async () => {
    await filled(500);

    expect(document.querySelector('[style*="max-height"]')).toBeNull();
    // What lets the port shrink past its own content when the pane runs out.
    // Without it a flex child stops at its content and the list grows the page
    // scroll instead of scrolling itself.
    expect(port().className).toContain("min-h-0");
    // And not `flex-1`, which would make the pane's height a target: a
    // twelve-row list would then hold the whole window open with its count
    // line stranded at the bottom.
    expect(port().className).not.toContain("flex-1");
  });

  /**
   * A filled table's port scrolls at any length, so the header has to hold at
   * any length too. Sticky used to arrive with the windowing, which meant a
   * 40-row list scrolled its own column labels away.
   */
  it("holds the column labels over a list too short to window", async () => {
    await filled(40);

    expect(document.querySelector("thead")!.className).toContain("sticky");
  });

  /** Search above, count below: neither scrolls with the rows. */
  it("leaves the search row and the count outside the scroll", async () => {
    await filled(500);

    const scrolled = port();
    expect(scrolled.contains(screen.getByLabelText("Search..."))).toBe(false);
    expect(scrolled.contains(screen.getByText("500 Pods"))).toBe(false);
  });
});

describe("the namespace column", () => {
  const withNamespace: ColumnDef<Item>[] = [
    ...columns,
    { accessorKey: "namespace", header: "Namespace" },
  ];

  /** Issue #178: with one namespace chosen the column repeated the scope bar on every row. */
  it("is hidden while one namespace is chosen, and back for all or several", async () => {
    useClusterStore.setState({ namespaceScope: ["ns"] });
    const { unmount } = await wrap(
      <DataTable<Item> columns={withNamespace} data={DATA} />
    );
    expect(screen.queryByText("Namespace")).toBeNull();
    unmount();
    useClusterStore.setState({ namespaceScope: [] });
    await wrap(<DataTable<Item> columns={withNamespace} data={DATA} />);
    expect(screen.getByText("Namespace")).toBeInTheDocument();
  });
});

describe("the search box", () => {
  /**
   * Issue #178: the search was component state, so leaving the tab and
   * coming back remounted the table with an empty box. It lives in the
   * query string now, which is what a tab records. Would break if the box
   * stopped reading the parameter, or stopped writing it.
   */
  it("reads its value from the query string and writes it back", async () => {
    await wrap(
      <DataTable<Item> columns={columns} data={DATA} searchParam="q" />,
      `${LIST}?q=b-2`
    );
    expect(search()).toHaveValue("b-2");
    await waitFor(() => expect(screen.queryByText("a-1")).toBeNull());
    fireEvent.change(search(), { target: { value: "a-1" } });
    await goesTo("/c/prod/pods?q=a-1");
    fireEvent.change(search(), { target: { value: "" } });
    await goesTo(LIST);
  });

  /**
   * The half the seed-once version could not do. The address changes under
   * a table that stays mounted whenever the reader clicks the sidebar row
   * for the list they are already on, follows a deep link, or jumps from
   * the palette — and the box kept the old text and the old rows while the
   * tab recorded the new address, so the filter was silently gone on the
   * way back. Fails if the box stops following the parameter.
   */
  it("follows the query string when the address changes underneath it", async () => {
    function Elsewhere() {
      const navigate = useNavigate();
      return (
        <button type="button" onClick={() => navigate({ href: LIST })}>
          drop it
        </button>
      );
    }
    await wrap(
      <>
        <DataTable<Item> columns={columns} data={DATA} searchParam="q" />
        <Elsewhere />
      </>,
      `${LIST}?q=b-2`
    );
    expect(search()).toHaveValue("b-2");
    fireEvent.click(screen.getByRole("button", { name: "drop it" }));
    await waitFor(() => expect(search()).toHaveValue(""));
    // The rows follow the box a render later, through the deferred value.
    await waitFor(() => expect(screen.getByText("a-1")).toBeInTheDocument());
  });
});

describe("typing in the search box", () => {
  /**
   * Every name link in a list read the whole query to learn the peek, so a
   * keystroke that wrote `?q=` drew them all again, and the shell's dock with
   * them. Fails if a reader of the peek is drawn again by the filter.
   */
  it("does not draw a reader of the peek again", async () => {
    let draws = 0;
    function PeekReader() {
      usePeek();
      draws += 1;
      return null;
    }
    await wrap(
      <>
        <DataTable<Item> columns={columns} data={DATA} searchParam="q" />
        <PeekReader />
      </>
    );
    const before = draws;
    for (const value of ["a", "a-", "a-1"]) {
      fireEvent.change(search(), { target: { value } });
      await goesTo(`/c/prod/pods?q=${value}`);
    }
    await settle(router);
    expect(draws).toBe(before);
  });
});

describe("a table offered to the screen's Share", () => {
  /** Every table registered under "table": the last one mounted, shared or
   *  not, replaced the others, and a list left the report without a trace. */
  it("reports each shared table and nothing for one without a share", async () => {
    function Probe() {
      const collect = useScreenSections();
      return (
        <button
          onClick={(event) => {
            event.currentTarget.textContent = (collect?.() ?? [])
              .map((section) => section.count)
              .join(",");
          }}
        >
          collect
        </button>
      );
    }
    await wrap(
      <ScreenShareProvider>
        <DataTable columns={columns} data={DATA} share={{ title: "Pods" }} />
        <DataTable
          columns={columns}
          data={DATA.slice(0, 1)}
          share={{ title: "Pods" }}
        />
        <DataTable columns={columns} data={DATA} />
        <Probe />
      </ScreenShareProvider>
    );
    const probe = screen.getByRole("button", { name: "collect" });
    fireEvent.click(probe);
    expect(probe.textContent).toBe("2,1");
  });
});
