import { describe, expect, it } from "vite-plus/test";
import { render, screen } from "@testing-library/react";

import { MetricsAbsenceContext } from "@/lib/metrics-absence";
import { MetricValue } from "./metric-value";

describe("a metric cell with no sample", () => {
  /**
   * A bare "-" under every CPU column looked like a value. Fails if a cell
   * stops saying it is not available, or stops saying why.
   */
  it("draws the could-not-look lock, with the reason, where the API was not served", () => {
    render(
      <MetricsAbsenceContext.Provider value="forbidden">
        <MetricValue used={null} type="cpu" />
      </MetricsAbsenceContext.Provider>
    );
    const cell = screen.getByRole("img", {
      name: "metrics not readable with this access",
    });
    expect(cell).toHaveAttribute(
      "title",
      "metrics not readable with this access"
    );
    expect(cell.querySelector("svg")).toHaveClass("lucide-lock");
  });

  /** Fails if a pod not scraped yet is blamed on the metrics API. */
  it("draws a missing sample as the warning glyph when the API answered", () => {
    render(<MetricValue used={null} type="memory" />);
    const cell = screen.getByRole("img", { name: "no sample yet" });
    expect(cell).toHaveAttribute("title", "no sample yet");
    expect(cell.querySelector("svg")).toHaveClass("lucide-triangle-alert");
    expect(screen.queryByText("no sample")).toBeNull();
  });
});

describe("a metric cell against a node's figure", () => {
  /** A node's tooltip said "limit" for what is its capacity. Fails if it says limit again. */
  it("names a node's figure capacity, not a limit", () => {
    render(
      <MetricValue
        used={5.9 * 2 ** 30}
        limit={7.8 * 2 ** 30}
        of="capacity"
        type="memory"
      />
    );
    const title = document.querySelector("[title]")!.getAttribute("title")!;
    expect(title).toContain("capacity");
    expect(title).not.toContain("limit");
  });

  /** Fails if a node with no capacity figure is told it has no limit. */
  it("says a node's missing capacity is not known, not that it has no limit", () => {
    render(<MetricValue used={1024} of="capacity" type="memory" />);
    const title = document.querySelector("[title]")!.getAttribute("title")!;
    expect(title).toContain("capacity not known");
    expect(title).not.toContain("limit");
  });
});
