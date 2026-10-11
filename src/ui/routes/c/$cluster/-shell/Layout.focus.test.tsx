import { act } from "@testing-library/react";
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
      await renderWithRouter(<Layout />, {
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
    }
  );
});
