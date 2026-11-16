import { describe, expect, it } from "vite-plus/test";
import { render, screen } from "@testing-library/react";
import { Info, TriangleAlert } from "lucide-react";

import { Alert } from "./alert";
import { Unknown } from "./unknown";

const FRAME = ["rounded-md", "border", "border-hair", "px-3", "py-2"];

describe("a notice beside a could-not-look", () => {
  /**
   * An amber left-ruled bar and a blue left-ruled card sat beside the dashed
   * frame `Unknown` draws: four notice looks on one page. Fails if a warning
   * stops drawing `Unknown`'s dashed frame, or information stops drawing the
   * same frame, solid.
   */
  it("draws Unknown's frame, dashed for a warning and solid for information", () => {
    render(
      <>
        <Unknown question="Who is behind this?" error={new Error("502")} />
        <Alert variant="warn">
          <TriangleAlert />
          <p>There is no namespace named all in this cluster</p>
        </Alert>
        <Alert variant="info">
          <Info />
          <p>No Prometheus is connected for this cluster.</p>
        </Alert>
      </>
    );
    const unknown = screen
      .getByText("Who is behind this?")
      .closest('[role="status"]')!;
    const warn = screen.getByText(/no namespace named all/).parentElement!;
    const info = screen.getByText(/No Prometheus/).parentElement!;
    for (const notice of [unknown, warn, info])
      expect(notice).toHaveClass(...FRAME);
    expect(unknown).toHaveClass("border-dashed");
    expect(warn).toHaveClass("border-dashed");
    expect(info).not.toHaveClass("border-dashed");
    for (const notice of [warn, info])
      expect(notice.className).not.toMatch(/border-l-2/);
  });
});
