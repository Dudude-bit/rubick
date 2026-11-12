import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";

import { DirectionCell } from "./network-policy-cells";

describe("a direction a policy does not govern, in its list row", () => {
  /**
   * The Egress column cut "not restricted by this policy" to "not restricted
   * by thi…". Fails if the row goes back to the sentence, or if hovering it
   * loses the sentence.
   */
  it("says it in two words and keeps the sentence on hover", () => {
    render(
      <DirectionCell
        direction={{
          governed: false,
          rules: [],
          opensToEverything: false,
          deniesEverything: false,
        }}
      />
    );
    expect(screen.getByText("not restricted")).toHaveAttribute(
      "title",
      "not restricted by this policy"
    );
  });
});
