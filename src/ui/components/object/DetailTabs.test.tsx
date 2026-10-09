import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
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

  /** The strip itself, not the individual tabs, is what absorbs overflow. */
  it("lets the tab strip scroll horizontally rather than clip its tabs", () => {
    render(
      <DetailTabs tabs={tabs} activeTab="overview" onTabChange={() => {}} />
    );
    const list = screen.getByRole("tablist");
    expect(list.className).toContain("overflow-x-auto");
    expect(list.className).not.toContain("truncate");
  });

  /**
   * At 1024 wide WebKit drew the strip's scrollbar over the bottom of the
   * labels, and a click below their top 6 px paged the strip instead of
   * opening the tab. Fails if the strip shows a scrollbar again.
   */
  it("hides the strip's scrollbar, which took the clicks meant for the labels", () => {
    render(
      <DetailTabs tabs={tabs} activeTab="overview" onTabChange={() => {}} />
    );
    const list = screen.getByRole("tablist");
    expect(list.className).toContain("scrollbar-none");
    expect(list.className).not.toContain("scrollbar-thin");
  });
});

describe("a tab strip wider than the page", () => {
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

  /** Where each tab sits, against a strip spanning 0 to 200. */
  function laidOut(spans: Record<string, [number, number]>) {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
      function (this: Element) {
        const tab = this.getAttribute("data-tab");
        const [left, right] =
          this.getAttribute("role") === "tablist"
            ? [0, 200]
            : tab
              ? spans[tab]
              : [0, 0];
        return {
          left,
          right,
          top: 0,
          bottom: 32,
          width: right - left,
          height: 32,
          x: left,
          y: 0,
          toJSON: () => ({}),
        } as DOMRect;
      }
    );
  }

  afterEach(() => vi.restoreAllMocks());

  /**
   * At 1024 wide Lena's pod page stopped after "Проверка сети", and
   * Условия, События, Зависимые and YAML had no way in. Fails if a tab
   * the strip cannot show is not offered by name, or picking it does not
   * open it.
   */
  it("names every tab it cannot show and opens the one picked", async () => {
    laidOut({
      overview: [0, 80],
      logs: [96, 180],
      events: [196, 260],
      yaml: [276, 320],
    });
    const onTabChange = vi.fn();
    render(
      <DetailTabs tabs={four} activeTab="overview" onTabChange={onTabChange} />
    );
    const more = screen.getByRole("button", {
      name: "2 more tabs do not fit",
    });
    expect(more).toHaveTextContent("2 more");
    expect(screen.getByRole("tablist").className).toContain("mask-image");

    await userEvent.click(more);
    const items = screen.getAllByRole("menuitem").map((i) => i.textContent);
    expect(items).toEqual(["Events", "YAML"]);
    await userEvent.click(screen.getByRole("menuitem", { name: "YAML" }));
    expect(onTabChange).toHaveBeenCalledWith("yaml");
  });

  /** A strip that shows every tab must not grow a control for nothing. */
  it("offers nothing more when every tab fits", () => {
    laidOut({
      overview: [0, 40],
      logs: [56, 90],
      events: [106, 150],
      yaml: [166, 200],
    });
    render(
      <DetailTabs tabs={four} activeTab="overview" onTabChange={() => {}} />
    );
    expect(screen.queryByRole("button", { name: /more/ })).toBeNull();
    expect(screen.getByRole("tablist").className).not.toContain("mask-image");
  });
});

describe("a tab strip that scrolls", () => {
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
  const SPANS: Record<string, [number, number]> = {
    overview: [0, 80],
    logs: [96, 180],
    events: [196, 260],
    yaml: [276, 320],
  };

  /** A strip 200 wide over 320 of tabs, each drawn where the strip's scroll puts it. */
  function scrolling() {
    const isStrip = (el: Element) => el.getAttribute("role") === "tablist";
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
      function (this: Element) {
        const tab = this.getAttribute("data-tab");
        const shift = this.closest<HTMLElement>('[role="tablist"]')?.scrollLeft;
        const [left, right] = isStrip(this)
          ? [0, 200]
          : tab
            ? SPANS[tab].map((x) => x - (shift ?? 0))
            : [0, 0];
        return {
          left,
          right,
          top: 0,
          bottom: 32,
          width: right - left,
          height: 32,
          x: left,
          y: 0,
          toJSON: () => ({}),
        } as DOMRect;
      }
    );
    vi.spyOn(Element.prototype, "clientWidth", "get").mockImplementation(
      function (this: Element) {
        return isStrip(this) ? 200 : 0;
      }
    );
    vi.spyOn(Element.prototype, "scrollWidth", "get").mockImplementation(
      function (this: Element) {
        return isStrip(this) ? 320 : 0;
      }
    );
  }

  function Page({ start = "overview" }: { start?: string }) {
    const [tab, setTab] = useState(start);
    return <DetailTabs tabs={four} activeTab={tab} onTabChange={setTab} />;
  }

  const strip = () => screen.getByRole("tablist");
  /** What the browser does after a scroll: the strip measures again. */
  const scrolledTo = (left: number) => {
    strip().scrollLeft = left;
    fireEvent.scroll(strip());
  };
  const pick = async (name: string) => {
    await userEvent.click(screen.getByRole("button", { name: /do not fit/ }));
    await userEvent.click(screen.getByRole("menuitem", { name }));
    fireEvent.scroll(strip());
  };

  afterEach(() => vi.restoreAllMocks());

  /**
   * Lena's first pick from "ещё N" scrolled its tab into view and every
   * later one left it off screen, with Зависимые's last letter under the
   * fade. Fails if any pick, not only the first, leaves the tab cut or
   * under a fade.
   */
  it("scrolls each picked tab whole and clear of the fade, every time", async () => {
    scrolling();
    render(<Page />);

    await pick("YAML");
    expect(strip().scrollLeft).toBe(120);
    expect(screen.getByText("the yaml panel")).toBeInTheDocument();

    await pick("Overview");
    expect(strip().scrollLeft).toBe(0);

    await pick("Events");
    expect(strip().scrollLeft).toBe(260 + 32 - 200);
  });

  /** Fails if picking the open tab after the strip was wheeled away from it leaves it out of sight. */
  it("brings the open tab back when it is picked again", async () => {
    scrolling();
    render(<Page start="yaml" />);
    expect(strip().scrollLeft).toBe(120);
    scrolledTo(0);

    await pick("YAML");
    expect(strip().scrollLeft).toBe(120);
  });

  /**
   * Radix focused each tab with a scroll that also moved the page around
   * the strip. Fails if the arrows open a tab, scroll anything but the
   * strip, or leave the focused tab out of sight.
   */
  it("walks the focus with the arrows, scrolling the strip alone", async () => {
    scrolling();
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const onTabChange = vi.fn();
    render(
      <DetailTabs tabs={four} activeTab="overview" onTabChange={onTabChange} />
    );
    screen.getByRole("tab", { name: "Overview" }).focus();

    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(screen.getByRole("tab", { name: "YAML" })).toHaveFocus();
    expect(focus).toHaveBeenLastCalledWith({ preventScroll: true });
    expect(strip().scrollLeft).toBe(120);

    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveFocus();
    expect(strip().scrollLeft).toBe(0);

    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    expect(screen.getByRole("tab", { name: "YAML" })).toHaveFocus();
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
