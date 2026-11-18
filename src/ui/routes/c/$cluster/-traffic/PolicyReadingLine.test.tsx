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

  /**
   * "Could not be read" was drawn in the colour of a finding: the reader
   * could not tell "no policy" from "the policies could not be looked at".
   * Each sentence that says it could not look is toned unknown; the rest
   * keep the line's colour.
   */
  it("tones the sentences that could not be read as unknown and no other", () => {
    const toned = (read: Read) => {
      const { unmount } = render(
        <ReadingText read={read} from={key("intruder")} to={key("db")} />
      );
      const parts = [
        ...screen.getByTestId("policy-reading").querySelectorAll("span"),
      ].map((span) => [
        span.textContent,
        span.className.includes("text-fg-fnt"),
      ]);
      unmount();
      return parts;
    };
    const unread = toned({
      says: "unread",
      why: "pods is forbidden",
      others: { known: false, why: "forbidden" },
    });
    expect(unread.filter(([, faint]) => faint)).toHaveLength(2);
    const known = toned({
      says: "notSelected",
      others: { known: true, value: [] },
    });
    expect(known.some(([, faint]) => faint)).toBe(false);
  });
});
