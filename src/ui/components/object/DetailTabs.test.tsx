import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Braces, Info, ScrollText, Activity } from "lucide-react";

import { DetailTabs } from "./DetailTabs";
import type { DetailTab } from "./detail-tab";

const tabs: DetailTab[] = [
  {
    id: "overview",
    label: "Overview",
    content: <p>the overview panel</p>,
    glyph: { names: "view", icon: Info },
  },
  {
    id: "logs",
    label: "Logs",
    content: <p>the logs panel</p>,
    glyph: { names: "view", icon: ScrollText },
  },
];

describe("DetailTabs", () => {
  /** A link naming a tab this page lacks would otherwise open a page with every panel hidden. */
  it("opens the first tab when the named one does not exist here", () => {
    render(<DetailTabs tabs={tabs} activeTab="files" onTabChange={() => {}} />);
    expect(screen.getByText("the overview panel")).toBeInTheDocument();
    expect(screen.queryByText("the logs panel")).not.toBeInTheDocument();
  });

  /** The fallback must not override a tab the page really has. */
  it("opens the named tab when it exists", () => {
    render(<DetailTabs tabs={tabs} activeTab="logs" onTabChange={() => {}} />);
    expect(screen.getByText("the logs panel")).toBeInTheDocument();
  });

  /** A clipped label reads as one letter; nothing here may shrink to get there. */
  it("never shrinks or truncates a tab label", () => {
    render(
      <DetailTabs tabs={tabs} activeTab="overview" onTabChange={() => {}} />
    );
    const label = screen.getByText("Overview");
    expect(label.className).not.toContain("truncate");
    const trigger = label.closest('[role="tab"]');
    expect(trigger?.className).not.toContain("min-w-0");
    expect(trigger?.className).toContain("shrink-0");
  });

  /** The strip clips everything outside it, so a ring drawn outside the tab lost its top and bottom. */
  it("draws a focused tab's ring inside the tab", () => {
    render(
      <DetailTabs tabs={tabs} activeTab="overview" onTabChange={() => {}} />
    );
    expect(screen.getByRole("tab", { name: "Overview" }).className).toContain(
      "focus-visible:ring-inset"
    );
  });

  /**
   * WebKit matches no :focus-visible for a focus that began with a click,
   * the arrows' focus after it included, so Dana and Lena walked the strip
   * blind. Fails if the tab the arrows reach wears no ring, or a click alone
   * draws one.
   */
  it("rings the tab the arrows reach after a click, and not the clicked one", () => {
    render(
      <DetailTabs tabs={tabs} activeTab="overview" onTabChange={() => {}} />
    );
    const overview = screen.getByRole("tab", { name: "Overview" });
    fireEvent.pointerDown(overview);
    overview.focus();
    expect(overview).not.toHaveAttribute("data-ring");

    fireEvent.keyDown(overview, { key: "ArrowRight" });
    const logs = screen.getByRole("tab", { name: "Logs" });
    expect(logs).toHaveFocus();
    expect(logs).toHaveAttribute("data-ring", "true");
    expect(logs.className).toContain("data-[ring=true]:ring-1");
    expect(overview).not.toHaveAttribute("data-ring");
  });

  /**
   * WebKitGTK names Shift+Tab "Unidentified", so Radix never let go of the
   * strip and Shift+Tab then Tab landed on "ещё N". Fails if the strip is
   * more than one Tab stop, or the stop is not the focused tab inside it and
   * the open tab outside it.
   */
  it("keeps the strip one Tab stop: the focused tab inside it, the open one outside", async () => {
    render(
      <>
        <button type="button">Back</button>
        <DetailTabs
          tabs={tabs}
          activeTab="overview"
          onTabChange={() => {}}
          actions={<button type="button">Delete</button>}
        />
      </>
    );
    const stops = () =>
      [screen.getByRole("tablist"), ...screen.getAllByRole("tab")].filter(
        (el) => el.tabIndex >= 0
      );
    const overview = screen.getByRole("tab", { name: "Overview" });
    const logs = screen.getByRole("tab", { name: "Logs" });
    expect(stops()).toEqual([overview]);

    overview.focus();
    fireEvent.keyDown(overview, { key: "ArrowRight" });
    expect(stops()).toEqual([logs]);

    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Delete" })).toHaveFocus();
    expect(stops()).toEqual([overview]);

    await userEvent.tab({ shift: true });
    expect(overview).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(screen.getByRole("button", { name: "Back" })).toHaveFocus();
  });

  /** WebKit starts Shift+Tab from the node a click lands on, and from a label inside the tab that was the tab again. */
  it("takes a click on the label on the tab itself", () => {
    render(
      <DetailTabs tabs={tabs} activeTab="overview" onTabChange={() => {}} />
    );
    expect(screen.getByRole("tab", { name: "Logs" }).className).toContain(
      "*:pointer-events-none"
    );
  });

  /** A tab strip too wide for the row wraps the actions below it, right-aligned. */
  it("wraps the actions onto their own line instead of squeezing the tabs", () => {
    render(
      <DetailTabs
        tabs={tabs}
        activeTab="overview"
        onTabChange={() => {}}
        actions={<button type="button">Delete</button>}
      />
    );
    const row = screen.getByRole("tablist").parentElement?.parentElement;
    expect(row?.className).toContain("flex-wrap");
    const actions = screen.getByText("Delete").closest("div");
    expect(actions?.className).toContain("ml-auto");
  });
});

describe("a tab strip wider than its row", () => {
  const four: DetailTab[] = [
    ...tabs,
    {
      id: "events",
      label: "Events",
      content: <p>the events panel</p>,
      glyph: { names: "view", icon: Activity },
    },
    {
      id: "yaml",
      label: "YAML",
      content: <p>the yaml panel</p>,
      glyph: { names: "view", icon: Braces },
    },
  ];
  /** Each tab's own width; together with the gaps they ask for 320. */
  const WIDTHS: Record<string, number> = {
    overview: 80,
    logs: 84,
    events: 64,
    yaml: 44,
  };
  const MENU = 50;

  const box = (width: number) =>
    ({
      left: 0,
      right: width,
      top: 0,
      bottom: 32,
      width,
      height: 32,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;

  /** The row the strip and its menu share is `room` wide. */
  function rowOf(room: () => number) {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
      function (this: Element) {
        const tab = this.getAttribute("data-tab");
        if (tab) return box(WIDTHS[tab]);
        if (/do not fit/.test(this.getAttribute("aria-label") ?? ""))
          return box(MENU);
        return box(0);
      }
    );
    vi.spyOn(Element.prototype, "clientWidth", "get").mockImplementation(
      function (this: Element) {
        return this.firstElementChild?.getAttribute("role") === "tablist"
          ? room()
          : 0;
      }
    );
  }

  function Page({ start = "overview" }: { start?: string }) {
    const [tab, setTab] = useState(start);
    return <DetailTabs tabs={four} activeTab={tab} onTabChange={setTab} />;
  }

  const inStrip = (name: string) =>
    !screen
      .getByRole("tab", { name, hidden: true })
      .hasAttribute("data-overflow");
  const menuItems = async () => {
    await userEvent.click(screen.getByRole("button", { name: /do not fit/ }));
    const items = screen.getAllByRole("menuitem").map((i) => i.textContent);
    await userEvent.keyboard("{Escape}");
    return items;
  };

  afterEach(() => vi.restoreAllMocks());

  /**
   * At 1024 wide Lena's pod page stopped after "Проверка сети", and
   * Условия, События, Зависимые and YAML had no way in. Fails if a tab
   * the strip cannot show is not offered by name, or picking it does not
   * open it.
   */
  it("names every tab it cannot show and opens the one picked", async () => {
    rowOf(() => 260);
    const onTabChange = vi.fn();
    render(
      <DetailTabs tabs={four} activeTab="overview" onTabChange={onTabChange} />
    );
    const more = screen.getByRole("button", {
      name: "2 more tabs do not fit",
    });
    expect(more).toHaveTextContent("2 more");

    await userEvent.click(more);
    const items = screen.getAllByRole("menuitem").map((i) => i.textContent);
    expect(items).toEqual(["Events", "YAML"]);
    await userEvent.click(screen.getByRole("menuitem", { name: "YAML" }));
    expect(onTabChange).toHaveBeenCalledWith("yaml");
  });

  /**
   * Lena read "Проверка се" cut at the strip's edge and the same tab in
   * "ещё 6". Fails if a tab is drawn in the strip and offered in the menu at
   * once, or the strip can draw part of a tab.
   */
  it("shows a tab whole in the strip or in the menu, never both and never cut", async () => {
    rowOf(() => 260);
    render(
      <DetailTabs tabs={four} activeTab="overview" onTabChange={() => {}} />
    );
    expect(["Overview", "Logs", "Events", "YAML"].map(inStrip)).toEqual([
      true,
      true,
      false,
      false,
    ]);
    const yaml = screen.getByRole("tab", { name: "YAML", hidden: true });
    expect(yaml.className).toContain("data-[overflow=true]:invisible");
    expect(yaml.tabIndex).toBe(-1);
    const strip = screen.getByRole("tablist");
    expect(strip.className).toContain("overflow-hidden");
    expect(strip.className).not.toContain("mask-image");
    expect(await menuItems()).toEqual(["Events", "YAML"]);
  });

  /**
   * Lena picked Связи from "ещё 6" and it opened somewhere she could not
   * see. Fails if a picked tab stays in the menu while the strip could show
   * it, or the tabs it displaces are not offered in its place.
   */
  it("brings a picked tab into the strip and offers what it displaced", async () => {
    rowOf(() => 260);
    render(<Page />);
    await userEvent.click(screen.getByRole("button", { name: /do not fit/ }));
    await userEvent.click(screen.getByRole("menuitem", { name: "YAML" }));

    expect(screen.getByText("the yaml panel")).toBeInTheDocument();
    expect(["Overview", "Logs", "Events", "YAML"].map(inStrip)).toEqual([
      true,
      false,
      false,
      true,
    ]);
    expect(await menuItems()).toEqual(["Logs", "Events"]);
  });

  /**
   * Lena's open YAML sat inside "5 more" and nothing said so. Fails if the
   * more button holding an open tab the strip cannot fit looks like any
   * other, or its menu does not mark which item is open.
   */
  it("marks the more button and the open tab inside it", async () => {
    rowOf(() => 60);
    render(<DetailTabs tabs={four} activeTab="yaml" onTabChange={() => {}} />);
    const more = screen.getByRole("button", {
      name: "4 more tabs do not fit. The open tab, YAML, is one of them",
    });
    expect(more).toHaveAttribute("data-holds-open", "true");

    await userEvent.click(more);
    expect(screen.getByRole("menuitem", { name: "YAML" })).toHaveAttribute(
      "aria-current",
      "true"
    );
    expect(
      screen.getByRole("menuitem", { name: "Events" })
    ).not.toHaveAttribute("aria-current");
  });

  /** A strip inside a panel nobody can see has no width yet; fails if it sends every tab to the menu for that. */
  it("keeps every tab in the strip while its row is not laid out", () => {
    rowOf(() => 0);
    render(
      <DetailTabs tabs={four} activeTab="overview" onTabChange={() => {}} />
    );
    expect(screen.queryByRole("button", { name: /more/ })).toBeNull();
    expect(["Overview", "Logs", "Events", "YAML"].every(inStrip)).toBe(true);
  });

  /** A strip that shows every tab must not grow a control for nothing. */
  it("offers nothing more when every tab fits", () => {
    rowOf(() => 320);
    render(
      <DetailTabs tabs={four} activeTab="overview" onTabChange={() => {}} />
    );
    expect(screen.queryByRole("button", { name: /more/ })).toBeNull();
    expect(["Overview", "Logs", "Events", "YAML"].every(inStrip)).toBe(true);
  });

  /**
   * The actions beside the strip wrap to their own row before a tab goes to
   * the menu. Fails if the row stops asking for every tab's width, which
   * lets the actions take the room the tabs need.
   */
  it("asks its row for the width of every tab", () => {
    rowOf(() => 260);
    render(
      <DetailTabs tabs={four} activeTab="overview" onTabChange={() => {}} />
    );
    expect(screen.getByRole("tablist").parentElement).toHaveStyle({
      flexBasis: "320px",
    });
  });

  /** Fails if a row that widens keeps tabs in the menu it now has room for. */
  it("takes the tabs back from the menu when the row widens", () => {
    let room = 260;
    rowOf(() => room);
    const resized: ResizeObserverCallback[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          resized.push(callback);
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
    render(<Page />);
    expect(screen.getByRole("button", { name: /do not fit/ })).toBeVisible();

    room = 320;
    act(() => resized.forEach((resize) => resize([], {} as ResizeObserver)));
    expect(screen.queryByRole("button", { name: /do not fit/ })).toBeNull();
    vi.unstubAllGlobals();
  });

  /**
   * Lena picked YAML from "ещё 5" with the mouse and its ring stayed, through
   * a deep link too: WebKit rings the focus the menu hands back as if a key
   * had brought it. Fails if a pick by pointer leaves the button ringed, or a
   * pick by keyboard leaves it without one.
   */
  it("rings the more button after a pick only when a key made it", async () => {
    rowOf(() => 260);
    render(
      <DetailTabs tabs={four} activeTab="overview" onTabChange={() => {}} />
    );
    const more = screen.getByRole("button", { name: /more tabs/ });
    expect(more.className).not.toContain("focus-visible:ring");

    await userEvent.click(more);
    await userEvent.click(screen.getByRole("menuitem", { name: "YAML" }));
    expect(more).toHaveFocus();
    expect(more).not.toHaveAttribute("data-ring");

    await userEvent.keyboard("{Enter}");
    await screen.findByRole("menuitem", { name: "Events" });
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(more).toHaveFocus();
    expect(more).toHaveAttribute("data-ring", "true");

    await userEvent.keyboard("{Enter}");
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "YAML" })
    );
    expect(more).toHaveFocus();
    expect(more).not.toHaveAttribute("data-ring");
  });

  /**
   * Radix focused each tab with a scroll that also moved the page around
   * the strip. Fails if the arrows open a tab, land on one the strip does
   * not show, or move the focus with a scroll.
   */
  it("walks the focus with the arrows through the tabs the strip shows", () => {
    rowOf(() => 260);
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const onTabChange = vi.fn();
    render(
      <DetailTabs tabs={four} activeTab="overview" onTabChange={onTabChange} />
    );
    screen.getByRole("tab", { name: "Overview" }).focus();

    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(screen.getByRole("tab", { name: "Logs" })).toHaveFocus();
    expect(focus).toHaveBeenLastCalledWith({ preventScroll: true });

    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveFocus();
    expect(onTabChange).not.toHaveBeenCalled();
  });
});

describe("a page moved to another object", () => {
  const surfaces: DetailTab[] = [
    tabs[0],
    {
      id: "shell",
      label: "Shell",
      kind: "surface",
      content: <p>a live shell</p>,
      glyph: { names: "view", icon: Activity },
    },
  ];

  /**
   * Dana used Shell on one pod, then a link moved the same page to another:
   * the Shell panel stayed mounted for the new pod and opened an exec in it.
   * Fails if what was opened for one object stays opened for the next.
   */
  it("forgets which surfaces were opened for the last one", () => {
    const { rerender } = render(
      <DetailTabs
        tabs={surfaces}
        activeTab="shell"
        onTabChange={() => {}}
        subject="Pod/shop/cart-a"
      />
    );
    rerender(
      <DetailTabs
        tabs={surfaces}
        activeTab="overview"
        onTabChange={() => {}}
        subject="Pod/shop/cart-a"
      />
    );
    expect(screen.getByText("a live shell")).toBeInTheDocument();

    rerender(
      <DetailTabs
        tabs={surfaces}
        activeTab="overview"
        onTabChange={() => {}}
        subject="Pod/shop/cart-b"
      />
    );
    expect(screen.queryByText("a live shell")).not.toBeInTheDocument();
  });
});
