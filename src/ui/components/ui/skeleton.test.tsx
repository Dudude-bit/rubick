import { describe, expect, it } from "vite-plus/test";
import { render, screen } from "@testing-library/react";

import { TableSkeleton } from "./skeleton";

describe("TableSkeleton", () => {
  /** A list nobody had counted drew eight bars for two rows. Fails if the unknown default grows back past a short list. */
  it("draws five rows when nothing says how many are coming", () => {
    render(<TableSkeleton widths={[100, 100]} />);
    expect(screen.getAllByTestId("skeleton-row")).toHaveLength(5);
  });

  /** Fails if a known count stops deciding the rows. */
  it("draws the rows it is told", () => {
    render(<TableSkeleton widths={[100, 100]} rows={2} />);
    expect(screen.getAllByTestId("skeleton-row")).toHaveLength(2);
  });
});
