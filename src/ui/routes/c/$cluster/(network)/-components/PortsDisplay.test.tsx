import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";

import { TooltipProvider } from "@/components/ui/tooltip";
import { PortsDisplay } from "./PortsDisplay";

describe("a named port wider than the Ports column", () => {
  /**
   * The cell cut "envoy-metrics · TCP" to "envoy-metrics · TC" with nothing
   * to say it was cut. Fails if a port stops ending in an ellipsis.
   */
  it("ends in an ellipsis instead of mid-letter", () => {
    render(
      <TooltipProvider>
        <PortsDisplay
          ports={[
            {
              name: "envoy-metrics",
              port: 9964,
              targetPort: "9964",
              nodePort: null,
              protocol: "TCP",
            },
          ]}
        />
      </TooltipProvider>
    );
    const port = screen.getByText("9964", { selector: ".text-fg" });
    expect(port.closest(".truncate")).not.toBeNull();
  });
});
