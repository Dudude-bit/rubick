import { afterEach, describe, expect, it } from "vite-plus/test";
import { render, screen } from "@testing-library/react";

import { useLocaleStore } from "@/stores/localeStore";
import type { LogRun } from "./grouping";
import { LogLineComponent, LogRunRow } from "./LogLine";
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

const draw = (spanMs: number, searchQuery = "") =>
  render(
    <LogRunRow
      run={run(spanMs)}
      expanded={false}
      containerColor={undefined}
      searchQuery={searchQuery}
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

describe("what a collapsed run marks for a search", () => {
  /**
   * Marco's "payments": the single lines lit the word and the collapsed
   * "payments slow" rows matched without it. Fails if a run row stops
   * drawing the search.
   */
  it("marks the match in a collapsed run's message like a single line", () => {
    draw(1_200, "retry");
    const marks = screen.getByTestId("log-run").querySelectorAll("mark");
    expect([...marks].map((mark) => mark.textContent)).toEqual(["retry"]);
  });
});

describe("where a search found a line the row does not show it in", () => {
  afterEach(() => useLocaleStore.setState({ choice: null }));

  const served = (id: number): StreamedLogLine => ({
    ...line(id, 1_700_000_000_000 + id),
    format: "json",
    message: "request served",
    raw: '{"msg":"request served","path":"/api/cart"}',
    fields: { path: "/api/cart" },
  });

  /**
   * Marco's "cart": the collapsed "request served × 155" run matched through
   * its lines' path and lit nothing. Fails if the run stops naming the field.
   */
  it("names the field a collapsed run matched in", () => {
    useLocaleStore.setState({ choice: "en" });
    render(
      <LogRunRow
        run={{ id: 1, start: 0, count: 2, head: served(1), tail: served(2) }}
        expanded={false}
        containerColor={undefined}
        searchQuery="cart"
        onToggle={() => {}}
      />
    );
    const where = screen.getByTestId("log-matched-in");
    expect(where.textContent).toBe("matched in path");
    expect(where.querySelector("mark")?.textContent).toBe("path");
  });

  const drawLine = (log: StreamedLogLine, query: string) =>
    render(
      <LogLineComponent
        log={log}
        viewMode="compact"
        searchQuery={query}
        containerColor={undefined}
        expanded={false}
        onToggleDetail={() => {}}
        lineId={log.id}
      />
    );

  /** A field the row draws is lit where it stands. Fails if a drawn field's match goes unmarked. */
  it("marks the match inside a field the row draws, and names nothing", () => {
    useLocaleStore.setState({ choice: "en" });
    const { container } = drawLine(served(1), "cart");
    expect(
      [...container.querySelectorAll("mark")].map((mark) => mark.textContent)
    ).toEqual(["cart"]);
    expect(screen.queryByTestId("log-matched-in")).toBeNull();
  });

  /** Fails if a match only Raw can show leaves the row silent. */
  it("sends a match outside the message and its fields to Raw", () => {
    useLocaleStore.setState({ choice: "en" });
    drawLine(
      {
        ...line(1, 1_700_000_000_000),
        raw: "I1007 06:41:09.603166 1 server.go:42] retrying",
      },
      "server.go"
    );
    expect(screen.getByTestId("log-matched-in").textContent).toBe(
      "matched outside the message: Raw shows it"
    );
  });
});

describe("what the Raw view marks for a search", () => {
  const STAMP = "2026-10-07T06:41:09.603166503Z";
  const MESSAGE = "GET /checkout 503 upstream=payments";
  const stamped: StreamedLogLine = {
    ...line(1, Date.parse(STAMP)),
    timestamp: STAMP,
    raw: `${STAMP} ${MESSAGE}`,
    message: MESSAGE,
  };

  const draw = (log: StreamedLogLine, query: string) =>
    render(
      <LogLineComponent
        log={log}
        viewMode="raw"
        searchQuery={query}
        containerColor={undefined}
        expanded={false}
        onToggleDetail={() => {}}
        lineId={log.id}
      />
    );

  /**
   * Marco searched 503 and Raw lit "503" inside `...603166503Z` of the line
   * the search had matched through its message, as if the timestamp had
   * been found. Fails if the highlight reads the stamp the search skips.
   */
  it("marks what the container wrote and leaves the timestamp's digits alone", () => {
    const { container } = draw(stamped, "503");
    expect(container.textContent).toBe(`${STAMP} ${MESSAGE}`);
    const marked = [...container.querySelectorAll("mark")];
    expect(marked.map((mark) => mark.textContent)).toEqual(["503"]);
  });

  /** A coloured line draws through its runs, and the run that holds the stamp is cut the same way. */
  it("leaves the timestamp's digits alone on a line drawn in runs too", () => {
    const { container } = draw(
      {
        ...stamped,
        segments: [{ text: `${STAMP} ` }, { text: MESSAGE }],
      },
      "503"
    );
    expect(
      [...container.querySelectorAll("mark")].map((mark) => mark.textContent)
    ).toEqual(["503"]);
  });

  /** The reading with one run over the stamp and the start of the message. */
  it("cuts a single run at the end of the timestamp, not at the run's start", () => {
    const { container } = draw(
      {
        ...stamped,
        segments: [{ text: stamped.raw }],
      },
      "503"
    );
    expect(
      [...container.querySelectorAll("mark")].map((mark) => mark.textContent)
    ).toEqual(["503"]);
  });

  /** A line with no timestamp read off it is searched whole, so it is marked whole. */
  it("marks a stamp-shaped start when no timestamp was read off the line", () => {
    const { container } = draw(
      { ...stamped, timestamp: null, message: "x" },
      "503"
    );
    expect(container.querySelectorAll("mark")).toHaveLength(2);
  });
});
