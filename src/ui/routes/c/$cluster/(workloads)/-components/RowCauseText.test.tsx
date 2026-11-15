import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";

import { VerdictWithCause } from "./RowCauseText";

describe("VerdictWithCause", () => {
  /**
   * lab/api's Status read "x Unavailab... 1 of 1 pod:...": the badge gave up
   * a fraction of a pixel to the cause beside it, which was enough for its
   * ellipsis to take three letters. Fails if the badge may shrink at all, or
   * the cause may not.
   */
  it("keeps the badge from shrinking and lets the cause give way", () => {
    render(
      <VerdictWithCause
        verdict="trouble"
        cause={{ says: "refused", said: "quota exceeded" }}
      >
        <span data-testid="badge">Unavailable</span>
      </VerdictWithCause>
    );
    expect(screen.getByTestId("badge").parentElement?.className).toContain(
      "shrink-0"
    );
    expect(
      screen.getByTestId("badge").parentElement?.nextElementSibling?.className
    ).toContain("min-w-0");
  });
});
