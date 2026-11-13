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
