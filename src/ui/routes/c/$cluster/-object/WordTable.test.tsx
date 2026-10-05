import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";

import { WordTable } from "./WordTable";

describe("a rules table", () => {
  /** A role that can bind or read every secret looked like any other row. */
  it("marks a verb that grants more than it names, and says what the mark means", () => {
    render(
      <WordTable
        table={{
          columns: ["resources", "verbs"],
          rows: [
            [{ words: ["secrets"] }, { words: ["*"], escalating: ["*"] }],
            [{ words: ["pods"] }, { words: ["*"] }],
          ],
        }}
        emptyMessage="none"
      />
    );
    const [escalating, wildcard] = screen.getAllByText("*");
    expect(escalating).toHaveClass("text-err");
    expect(escalating).toHaveTextContent("grants more than it names");
    expect(wildcard).toHaveClass("text-warn");
    expect(wildcard).toHaveTextContent("matches every value");
    expect(screen.getByText(/Marked verbs reach past the rule/)).toBeVisible();
  });

  it("says nothing about marks where no verb carries one", () => {
    render(
      <WordTable
        table={{ columns: ["verbs"], rows: [[{ words: ["get"] }]] }}
        emptyMessage="none"
      />
    );
    expect(screen.queryByText(/Marked verbs/)).toBeNull();
  });
});
