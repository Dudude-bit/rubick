import { describe, expect, it } from "vite-plus/test";
import { render } from "@testing-library/react";

import { TabMark } from "./tab-marks";

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
