import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";

import type { FlowSource } from "@/lib/traffic";
import { SourceRail } from "./SourceRail";

const HUBBLE: FlowSource = {
  id: "hubble",
  name: "Hubble",
  state: { says: "absent" },
  measures: [],
  found: [],
  need: "needHubble",
  marks: false,
  nodeAgent: true,
  needsPods: false,
  grpcErrors: false,
};

describe("the sources rail", () => {
  /**
   * Hubble's labelsContext list has no space in it: unbroken, it ran past
   * the rail's edge under a sideways scrollbar, cut mid-label. It breaks
   * anywhere, can be selected to copy, and the rail never scrolls sideways.
   */
  it("breaks a source's instruction anywhere, lets it be copied, and never scrolls sideways", () => {
    render(<SourceRail sources={[HUBBLE]} reading={null} />);
    const need = screen.getByTestId("source-need");
    expect(need.textContent).toContain(
      "labelsContext=source_namespace,source_workload"
    );
    expect(need).toHaveClass("wrap-anywhere", "select-text");
    expect(screen.getByRole("complementary")).toHaveClass("overflow-x-hidden");
  });
});
