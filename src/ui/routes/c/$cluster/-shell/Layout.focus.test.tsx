import { act, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import type { ColumnDef } from "@/components/ui/table-features";
import { renderWithRouter } from "@/test/render";

vi.mock("@/lib/commands", () => ({
  commands: new Proxy(
    {},
    { get: (_, name) => (name === "then" ? undefined : async () => null) }
  ),
}));

vi.mock("@/hooks/useClusterOverview", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useClusterOverview")>()),
  useClusterOverview: () => ({ data: undefined }),
  useScopedOverview: () => ({ data: undefined, isPlaceholderData: false }),
}));

interface Row {
  name: string;
}

const columns: ColumnDef<Row>[] = [
  { id: "name", header: "Name", accessorKey: "name" },
];

vi.mock("./PageArea", async () => {
  const { DataTable } = await import("@/components/ui/data-table");
  return {
    PageArea: () => (
      <DataTable
        columns={columns}
        data={[{ name: "web-1" }, { name: "web-2" }]}
        getRowId={(row) => row.name}
        enableKeyboardNav
      />
    ),
  };
});

const { Layout } = await import("./Layout");
const { useClusterStore } = await import("@/stores/clusterStore");
const { Toaster } = await import("@/components/ui/toaster");
const { SettingsOverlay } =
  await import("@/components/settings/SettingsOverlay");
const { startFocusWrap } = await import("@/lib/focus-modality");

/** The shell as the window mounts it: the route's Layout and what the root puts beside it. */
const Shell = () => (
  <>
    <Layout />
    <SettingsOverlay />
    <Toaster />
  </>
);

beforeAll(() => {
  Element.prototype.scrollIntoView ??= () => {};
});

beforeEach(() => {
  useClusterStore.setState({ isConnected: true, currentContext: "prod" });
});

const word = (cls: string) => new RegExp(`(^|\\s)(${cls})(\\s|$)`);
const UNSEEN = word("sr-only|opacity-0|invisible|hidden");
const NO_OUTLINE = word("(focus-visible:|focus:)?outline-(hidden|none)");
const RING = word("(focus-visible:|data-\\[ring=true\\]:)?ring(-[0-9])?");

/** Why a focused stop draws nothing, or null when it shows the focus. */
function blindness(el: HTMLElement): string | null {
  const cls = el.getAttribute("class") ?? "";
  if (UNSEEN.test(cls) || el.closest("[aria-hidden='true']")) return "unseen";
  if (!NO_OUTLINE.test(cls) || RING.test(cls)) return null;
  const field = el.matches("input, textarea");
  if (field && /focus-within:/.test(el.parentElement?.className ?? ""))
    return null;
  return "outline hidden and no ring";
}

const label = (el: Element) =>
  `${el.tagName.toLowerCase()} "${(el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 40)}"`;

describe("the shell's Tab order", () => {
  /**
   * Dana tabbed off a table onto stops that drew nothing and could not tell
   * where the focus was. Fails if any stop from the rail to the status bar
   * hides its outline without drawing a ring of its own.
   */
  it(
    "lands only on controls that show they hold the focus",
    { timeout: 60_000 },
    async () => {
      await renderWithRouter(<Shell />, {
        at: "/c/prod",
        route: "/c/$cluster/$",
      });
      await act(async () => {});
      const user = userEvent.setup();
      const stops: string[] = [];
      const blind: string[] = [];
      const seen = new Set<Element>();
      for (;;) {
        await user.tab();
        const el = document.activeElement as HTMLElement | null;
        if (!el || el === document.body || seen.has(el)) break;
        seen.add(el);
        stops.push(label(el));
        const why = blindness(el);
        if (why) blind.push(`${label(el)}: ${why}`);
      }

      expect(stops).toContain('button "Rename or recolour prod"');
      expect(stops.some((stop) => stop.startsWith('tr "web-1'))).toBe(true);
      expect(stops).toContain('button "Theme: Dark"');
      expect(blind).toEqual([]);
      expect(stops[0]).toBe('button "Rename or recolour prod"');
      expect(stops.at(-1)).toBe('button "Theme: Dark"');
    }
  );

  /**
   * Dana's Shift+Tab off the cluster name drew no ring anywhere for one press:
   * the cluster name is the window's first stop, so the press left the
   * document and WebKitGTK gave the focus to nothing. Fails if Shift+Tab there
   * does not land on the status bar's last control, or Tab there on the first.
   */
  it("wraps between the cluster name and the status bar inside the window", async () => {
    const stop = startFocusWrap();
    try {
      await renderWithRouter(<Shell />, {
        at: "/c/prod",
        route: "/c/$cluster/$",
      });
      await act(async () => {});
      const cluster = document.querySelector<HTMLElement>(
        "[aria-label='Rename or recolour prod']"
      )!;
      // A bare keydown, which jsdom gives no default action: what moves the
      // focus is the wrap, as it has to be in a webview that drops it.
      cluster.focus();
      fireEvent.keyDown(cluster, { key: "Tab", shiftKey: true });
      expect(label(document.activeElement!)).toBe('button "Theme: Dark"');
      fireEvent.keyDown(document.activeElement!, { key: "Tab" });
      expect(document.activeElement).toBe(cluster);
    } finally {
      stop();
    }
  });

  /**
   * Dana clicked Pods, then Overview, in the sidebar and Shift+Tab never left
   * the row: WebKitGTK steps back from the pressed label and finds the row
   * itself. Fails if Shift+Tab after a pointer click on a row does not land
   * on the stop before it.
   */
  it("steps back from a sidebar row the pointer clicked", async () => {
    const stop = startFocusWrap();
    try {
      await renderWithRouter(<Shell />, {
        at: "/c/prod",
        route: "/c/$cluster/$",
      });
      await act(async () => {});
      const user = userEvent.setup();
      const row = (name: string) =>
        [...document.querySelectorAll<HTMLElement>("nav a[href]")].find(
          (a) => a.textContent?.trim() === name
        )!;
      const webkitShiftTab = {
        key: "Unidentified",
        code: "Tab",
        keyCode: 9,
        shiftKey: true,
      };

      await user.click(row("Pods").querySelector("span")!);
      expect(document.activeElement).toBe(row("Pods"));
      fireEvent.keyDown(document.activeElement!, webkitShiftTab);
      expect(document.activeElement).toBe(row("Changes"));

      await user.click(row("Overview").querySelector("span")!);
      fireEvent.keyDown(document.activeElement!, webkitShiftTab);
      expect(label(document.activeElement!)).toBe(
        'button "Rename or recolour prod"'
      );
    } finally {
      stop();
    }
  });
});

describe("the page scroller", () => {
  /**
   * Lena scrolled a Deployment at 1024 and read the page through a strip
   * above the stuck tab bar: a sticky bar sticks below its scroller's
   * padding. Fails if the scroller gets top padding again.
   */
  it("keeps its top gap inside the page, where a stuck tab bar covers it", async () => {
    await renderWithRouter(<Shell />, {
      at: "/c/prod",
      route: "/c/$cluster/$",
    });
    await act(async () => {});
    const main = document.querySelector("main")!;
    expect(main.className).not.toMatch(word("p-[0-9]+|pt-[0-9]+|py-[0-9]+"));
    expect(main.firstElementChild?.className).toMatch(word("pt-4"));
  });
});
