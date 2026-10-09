import { describe, expect, it } from "vite-plus/test";
import { render, screen } from "@testing-library/react";

import { MetricsAbsenceContext } from "@/lib/metrics-absence";
import { MetricValue } from "./metric-value";

describe("a metric cell with no sample", () => {
  /**
   * A bare "-" under every CPU column looked like a value. Fails if a cell
   * stops saying it is not available, or stops saying why.
   */
  it("says not available, with the reason, where the API was not served", () => {
    render(
      <MetricsAbsenceContext.Provider value="forbidden">
        <MetricValue used={null} type="cpu" />
      </MetricsAbsenceContext.Provider>
    );
    const cell = screen.getByText("n/a");
    expect(cell).toHaveAttribute(
      "title",
      "metrics not readable with this access"
    );
  });

  /** Fails if a pod not scraped yet is blamed on the metrics API. */
  it("calls a missing sample a missing sample when the API answered", () => {
    render(<MetricValue used={null} type="memory" />);
    expect(screen.getByText("no sample")).toHaveAttribute(
      "title",
      "no sample yet"
    );
  });
});
