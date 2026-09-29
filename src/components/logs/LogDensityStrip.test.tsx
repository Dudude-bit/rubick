/**
 * The strip is handed the filter's partial result and, before this, was
 * never told the walk was still running. With nothing reached yet it said
 * "No line matches the query." over a query nobody had finished asking —
 * the third state drawn as the second, beside a list that said "Filtering…"
 * at the same moment.
 */

import { afterEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { useLocaleStore } from "@/stores/localeStore";
import { LogDensityStrip } from "./LogDensityStrip";
import type { StreamedLogLine } from "./types";

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

const line = (id: number, epoch: number): StreamedLogLine => ({
  id,
  epoch,
  groupKey: `k${id}`,
  timestamp: null,
  format: "plain",
  raw: "m",
  message: "m",
  pod: "p",
  container: "app",
  namespace: "n",
  level: "info",
  fields: null,
});

const burst = (offsets: number[]) =>
  offsets.map((offset, index) => line(index, 1_700_000_000_000 + offset));

describe("what the density strip says when the lines are too close to map", () => {
  afterEach(() => useLocaleStore.setState({ choice: null }));

  /**
   * A burst inside one clock tick printed its span as the English word
   * "instant", and the count took one Russian form for every number:
   * "Все 3 строк пришли в пределах instant друг от друга".
   */
  it("says a burst with no span landed at one moment, in the reader's language", () => {
    useLocaleStore.setState({ choice: "ru" });
    const logs = burst([0, 0, 0]);
    render(
      <LogDensityStrip {...common} mode="full" logs={logs} retained={3} />
    );
    expect(document.body.textContent).toContain(
      "Все 3 строки пришли в один и тот же момент"
    );
    expect(document.body.textContent).not.toMatch(/instant/);
  });

  /** Would break if the count stopped choosing its form by the number. */
  it("counts the lines with the form the number takes", () => {
    useLocaleStore.setState({ choice: "ru" });
    const logs = burst([0, 50, 100, 150]);
    render(
      <LogDensityStrip {...common} mode="full" logs={logs} retained={4} />
    );
    expect(document.body.textContent).toContain(
      "Все 4 строки пришли в пределах 150ms"
    );
  });

  /** English keeps its own sentence for the same burst. */
  it("says the same moment in English", () => {
    useLocaleStore.setState({ choice: "en" });
    render(
      <LogDensityStrip
        {...common}
        mode="full"
        logs={burst([0, 0])}
        retained={2}
      />
    );
    expect(document.body.textContent).toContain(
      "All 2 lines landed at the same moment"
    );
  });
});
