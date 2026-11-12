import { describe, expect, it } from "vite-plus/test";
import { render, screen } from "@testing-library/react";

import { TrafficChart } from "./traffic-chart";

describe("TrafficChart", () => {
  /**
   * The newest reading had bytes out and none in, and the figure beside the
   * band said `0 B/s` over a legend saying `unknown`. Fails if a direction
   * nothing answered for is printed as a rate of zero.
   */
  it("says unknown, not 0 B/s, for a newest reading with no bytes in", () => {
    render(
      <TrafficChart
        window={{
          points: [
            { t: 1_000, rx: 10, tx: 5 },
            { t: 2_000, rx: null, tx: 7 },
          ],
          resolution: { key: "promBucketsMaxOver", values: {} },
        }}
      />
    );

    expect(screen.queryByText("0 B/s")).not.toBeInTheDocument();
    expect(screen.getByRole("img").getAttribute("aria-label")).toContain(
      "now in unknown"
    );
  });
});
