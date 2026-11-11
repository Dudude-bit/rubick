import { describe, expect, it } from "vite-plus/test";
import { render } from "@testing-library/react";

import { kindGlyph } from "./detail-tab";
import { TabGlyph, TabMark } from "./tab-marks";

describe("TabMark", () => {
  /**
   * Marco's ledger page wore a hollow ring on its Pods tab where its header,
   * Usage block and traffic row drew the not-read eye for the same pods.
   * Fails if a tab nobody could check is drawn with a mark of its own again,
   * or with a coloured one.
   */
  it("marks a tab nobody could check with the not-read eye, uncoloured", () => {
    const { container } = render(
      <TabMark
        mark={{ shows: "unchecked", says: "Could not read these pods." }}
        isActive={false}
      />
    );
    const mark = container.querySelector("svg");
    expect(mark).toHaveClass("lucide-eye-off");
    expect(mark).toHaveClass("text-fg-fnt");
  });
});

describe("TabGlyph", () => {
  /**
   * The Instances tab of Knative's `services` CRD wore the core Service's
   * glyph. Fails if a tab naming a kind by the CRD that serves it draws the
   * built-in of that name, or a registry kind's tab loses its glyph.
   */
  it("draws a custom kind named like a built-in with a mark of its own", () => {
    const { container, rerender } = render(
      <TabGlyph
        glyph={kindGlyph("Service", "services.serving.knative.dev")}
        isActive
      />
    );
    expect(container.querySelector("svg")).toHaveClass("lucide-circle-dashed");
    rerender(<TabGlyph glyph={kindGlyph("Service")} isActive />);
    expect(container.querySelector("svg")).not.toHaveClass(
      "lucide-circle-dashed"
    );
  });
});
