/**
 * The strip is handed the filter's partial result and, before this, was
 * never told the walk was still running. With nothing reached yet it said
 * "No line matches the query." over a query nobody had finished asking —
 * the third state drawn as the second, beside a list that said "Filtering…"
 * at the same moment.
 */

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { LogDensityStrip } from "./LogDensityStrip";

const common = {
  logs: [],
  scope: "q",
  lost: { before: 0, from: null } as never,
  intake: false,
  selection: null,
  frozen: null,
  viewportFrom: 0,
  viewportTo: 0,
  onJump: () => {},
  onSelect: () => {},
  onClearSelection: () => {},
  mode: "band" as const,
  onModeChange: () => {},
};

describe("what the density strip says with nothing to map", () => {
  it("does not call a walk still running a query that matched nothing", () => {
    render(<LogDensityStrip {...common} retained={40000} settling />);
    expect(screen.queryByText(/no line matches/i)).toBeNull();
    expect(screen.getAllByText(/filtering/i).length).toBeGreaterThan(0);
  });

  it("says nothing matched once the walk is over", () => {
    render(<LogDensityStrip {...common} retained={40000} settling={false} />);
    expect(document.body.textContent).toMatch(/no line/i);
  });

  it("still tells an empty buffer from a query that found nothing", () => {
    render(<LogDensityStrip {...common} retained={0} settling={false} />);
    expect(screen.queryByText(/no line matches/i)).toBeNull();
  });
});
