import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";

import { LogQuery } from "./LogQuery";
import {
  appendCapped,
  emptyBuffer,
  MAX_TRACKED_VALUES,
  type FieldIndex,
} from "./hooks/log-buffer";
import { fieldTerm, type QueryTerm, type StreamedLogLine } from "./types";

const line = (
  id: number,
  container: string,
  level: string,
  fields: Record<string, string> | null
) =>
  ({
    id,
    epoch: id,
    groupKey: "",
    timestamp: null,
    message: `m${id}`,
    level,
    format: fields ? "json" : "plain",
    fields,
    raw: `m${id}`,
    pod: "log-demo",
    container,
    namespace: "default",
  }) as StreamedLogLine;

function indexOf(lines: StreamedLogLine[]): FieldIndex {
  return appendCapped(emptyBuffer(), lines, 10000).fields;
}

/** The draft is owned by the viewer, so the box needs a real one to type into. */
function Harness({
  fields,
  onAddTerm,
  terms = [],
}: {
  fields: FieldIndex;
  onAddTerm: (term: QueryTerm) => void;
  terms?: QueryTerm[];
}) {
  const [draft, setDraft] = useState("");
  return (
    <LogQuery
      terms={terms}
      draft={draft}
      onDraftChange={setDraft}
      onAddTerm={onAddTerm}
      onRemoveTerm={() => {}}
      fields={fields}
    />
  );
}

const STRUCTURED = indexOf([
  line(1, "app", "info", { component: "ingest", upstream: "db" }),
  line(2, "app", "error", { component: "ingest" }),
  line(3, "sidecar", "info", { component: "api" }),
]);

const options = () =>
  within(screen.getByRole("listbox")).getAllByRole("option");
const names = () => options().map((option) => option.textContent);

describe("the query box, focused", () => {
  it("offers what the buffer can actually be filtered by, counts included", async () => {
    const user = userEvent.setup();
    render(<Harness fields={STRUCTURED} onAddTerm={() => {}} />);

    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    await user.click(screen.getByLabelText("Filter the log"));

    // level and container first — the two people reach for before they
    // know what the parser found — then the parsed keys, loudest first.
    expect(names()).toEqual([
      "level3 lines",
      "container3 lines",
      "component3 lines",
      "upstream1 line",
    ]);
  });

  it("produces the same term a row click produces, in two steps", async () => {
    const user = userEvent.setup();
    const onAddTerm = vi.fn();
    render(<Harness fields={STRUCTURED} onAddTerm={onAddTerm} />);

    await user.click(screen.getByLabelText("Filter the log"));
    await user.click(screen.getByText("component"));

    // Values of the key, by count. Not "component exists".
    expect(names()).toEqual(["ingest2 lines", "api1 line"]);

    await user.click(screen.getByText("ingest"));
    expect(onAddTerm).toHaveBeenCalledWith(fieldTerm("component", "ingest"));
    expect(onAddTerm).toHaveBeenCalledWith({
      kind: "field",
      key: "component",
      op: "=",
      value: "ingest",
    });
  });

  it("turns a level suggestion into a level term, not a field test", async () => {
    // No line carries a `level` key — the parser lifts it out — so a field
    // test on one would match nothing, and could never be widened to ≥.
    const user = userEvent.setup();
    const onAddTerm = vi.fn();
    render(<Harness fields={STRUCTURED} onAddTerm={onAddTerm} />);

    await user.click(screen.getByLabelText("Filter the log"));
    await user.click(screen.getByText("level"));
    await user.click(screen.getByText("info"));

    expect(onAddTerm).toHaveBeenCalledWith({
      kind: "level",
      op: "=",
      value: "info",
    });
  });

  it("filters the list as you type, and still commits free text on enter", async () => {
    const user = userEvent.setup();
    const onAddTerm = vi.fn();
    render(<Harness fields={STRUCTURED} onAddTerm={onAddTerm} />);

    const input = screen.getByLabelText("Filter the log");
    await user.click(input);
    await user.type(input, "up");
    expect(names()).toEqual(["upstream1 line"]);

    // Nothing is highlighted until an arrow says so, so enter means what
    // it has always meant.
    await user.type(input, "{Enter}");
    expect(onAddTerm).toHaveBeenCalledWith({ kind: "text", value: "up" });
  });

  it("takes the arrows and enter for the option it highlights", async () => {
    const user = userEvent.setup();
    const onAddTerm = vi.fn();
    render(<Harness fields={STRUCTURED} onAddTerm={onAddTerm} />);

    const input = screen.getByLabelText("Filter the log");
    await user.click(input);
    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(input).toHaveFocus();

    // Second key is `container`; enter on it steps into its values.
    await user.keyboard("{ArrowDown}{Enter}");
    expect(onAddTerm).toHaveBeenCalledWith({
      kind: "field",
      key: "container",
      op: "=",
      value: "app",
    });
    expect(
      input,
      "the reader is typing; nothing here may take the caret"
    ).toHaveFocus();
  });

  it("closes on escape without touching the query", async () => {
    const user = userEvent.setup();
    const onAddTerm = vi.fn();
    render(<Harness fields={STRUCTURED} onAddTerm={onAddTerm} />);

    const input = screen.getByLabelText("Filter the log");
    await user.click(input);
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(onAddTerm).not.toHaveBeenCalled();
  });

  it("does not try to list a key with one value per line", async () => {
    const user = userEvent.setup();
    const onAddTerm = vi.fn();
    const flood = indexOf(
      Array.from({ length: MAX_TRACKED_VALUES + 5 }, (_, i) =>
        line(i, "web", "info", { request_id: `r${i}` })
      )
    );
    render(<Harness fields={flood} onAddTerm={onAddTerm} />);

    await user.click(screen.getByLabelText("Filter the log"));
    await user.click(screen.getByText("request_id"));

    expect(
      within(screen.getByRole("listbox")).queryAllByRole("option")
    ).toEqual([]);
    expect(
      screen.getByText(/too many to list/),
      "ten thousand buttons is not a choice"
    ).toBeInTheDocument();

    // The way in is still open: the key is chosen, so what is typed under
    // it is its value.
    await user.type(screen.getByLabelText("Filter the log"), "r7{Enter}");
    expect(onAddTerm).toHaveBeenCalledWith({
      kind: "field",
      key: "request_id",
      op: "=",
      value: "r7",
    });
  });

  it("says a plain-text pod is plain rather than looking broken", async () => {
    const user = userEvent.setup();
    const plain = indexOf([
      line(1, "app", "unknown", null),
      line(2, "app", "unknown", null),
    ]);
    render(<Harness fields={plain} onAddTerm={() => {}} />);

    await user.click(screen.getByLabelText("Filter the log"));

    expect(names()).toEqual(["level2 lines", "container2 lines"]);
    expect(screen.getByText(/no structured fields/)).toBeInTheDocument();
  });
});
