import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";

import type { WorkloadKey } from "@/generated/types";
import { ReadingText, type Read } from "./PolicyReadingLine";

const key = (name: string): WorkloadKey => ({
  namespace: "shop",
  group: "apps",
  kind: "Deployment",
  name,
});

describe("the app's reading under a drop", () => {
  /**
   * The reading sits inside the drop's line, a paragraph: drawn as one of
   * its own it nested a paragraph in a paragraph, which React refuses and
   * the HTML parser would split.
   */
  it("is drawn inside the drop's line with no paragraph inside a paragraph", () => {
    const read: Read = {
      says: "notSelected",
      others: { known: true, value: [] },
    };
    const { container } = render(
      <p>
        POLICY_DENIED: 1/s
        <ReadingText read={read} from={key("intruder")} to={key("db")} />
      </p>
    );
    expect(screen.getByTestId("policy-reading").textContent).toContain(
      "No NetworkPolicy restricts"
    );
    expect(container.querySelector("p p")).toBeNull();
  });
});
