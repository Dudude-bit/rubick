import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render, screen } from "@testing-library/react";
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
