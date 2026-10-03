import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Info, ScrollText } from "lucide-react";

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
    const row = screen.getByRole("tablist").parentElement;
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
