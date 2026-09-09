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
});
