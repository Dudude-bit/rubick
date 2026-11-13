import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";

import type { EventInfo } from "@/generated/types";

import { CountCell } from "./EventsTable";

const row = (count: number | null) =>
  ({
    original: { count, firstTimestamp: null, lastTimestamp: null },
  }) as unknown as { original: EventInfo };

describe("the Events table's Count cell", () => {
  /** A column blank on every row read as broken. Fails if a count of one is hidden again. */
  it("says a count of one", () => {
    render(<CountCell row={row(1)} />);
    expect(screen.getByText("×1")).toBeInTheDocument();
  });

  /** Fails if a repeat's tally is not shown. */
  it("says a repeat's count", () => {
    render(<CountCell row={row(7)} />);
    expect(screen.getByText("×7")).toBeInTheDocument();
  });

  /** A count the cluster did not report is not one. Fails if null is drawn as a number. */
  it("does not make up a count the cluster did not report", () => {
    render(<CountCell row={row(null)} />);
    expect(screen.queryByText(/×/)).not.toBeInTheDocument();
  });
});
