import { describe, expect, it } from "vite-plus/test";
import { render } from "@testing-library/react";

import { ReasonText } from "./ReasonText";

describe("ReasonText", () => {
  /**
   * The Events table cut reasons to "FailedSc…" and "Succ…", which read the
   * same for SuccessfulCreate and SuccessfulDelete. Fails if the reason is
   * drawn to be cut rather than wrapped between its words.
   */
  it("wraps a reason between its words and never cuts it", () => {
    const { container } = render(<ReasonText reason="SuccessfulCreate" />);
    const text = container.firstElementChild as HTMLElement;
    expect(text).toHaveTextContent("SuccessfulCreate");
    expect(text.querySelectorAll("wbr")).toHaveLength(1);
    expect(text.className).toContain("whitespace-normal");
    expect(text.className).not.toContain("truncate");
  });
});
