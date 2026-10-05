import { afterEach, describe, expect, it } from "vite-plus/test";
import { render, screen } from "@testing-library/react";

import { useLocaleStore } from "@/stores/localeStore";
import type { LogRun } from "./grouping";
import { LogRunRow } from "./LogLine";
import type { StreamedLogLine } from "./types";

const line = (id: number, epoch: number): StreamedLogLine => ({
  id,
  epoch,
  groupKey: "same",
  timestamp: null,
  format: "plain",
  raw: "retrying",
  message: "retrying",
  pod: "p",
  container: "app",
  namespace: "n",
  level: "info",
  fields: null,
});

const run = (spanMs: number): LogRun => ({
  id: 1,
  start: 0,
  count: 3,
  head: line(1, 1_700_000_000_000),
  tail: line(3, 1_700_000_000_000 + spanMs),
});

const draw = (spanMs: number) =>
  render(
    <LogRunRow
      run={run(spanMs)}
      expanded={false}
      containerColor={undefined}
      onToggle={() => {}}
    />
  );

describe("how a collapsed run of repeats says how long it took", () => {
  afterEach(() => useLocaleStore.setState({ choice: null }));

  /**
   * The count and span were glued with an English "over", and a burst
   * inside one clock tick printed "instant": "× 3 over instant" on a
   * Russian screen.
   */
  it("says a burst with no span happened at one moment, in the reader's language", () => {
    useLocaleStore.setState({ choice: "ru" });
    draw(0);
    const row = screen.getByTestId("log-run");
    expect(row).toHaveTextContent("× 3 в один и тот же момент");
    expect(row.textContent).not.toMatch(/over|instant/);
  });

  /** Would break if the span stopped being carried inside the sentence, or
   *  went back to English units inside it. */
  it("names the span of a run that took time", () => {
    useLocaleStore.setState({ choice: "ru" });
    draw(1_200);
    expect(screen.getByTestId("log-run")).toHaveTextContent("× 3 за 1,2 с");
  });

  /** Both sentences have their own English, which the Russian cases above do not hold. */
  it.each([
    [0, "× 3 at the same moment"],
    [1_200, "× 3 over 1.2s"],
  ])("says a run of span %i ms in English", (span, words) => {
    useLocaleStore.setState({ choice: "en" });
    draw(span);
    expect(screen.getByTestId("log-run")).toHaveTextContent(words);
  });
});
