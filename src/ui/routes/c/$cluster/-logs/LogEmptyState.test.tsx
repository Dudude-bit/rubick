import type { ComponentProps } from "react";
import { describe, expect, it } from "vite-plus/test";
import { render, screen } from "@testing-library/react";

import { EmptyState } from "./LogEmptyState";

const pane = (props: Partial<ComponentProps<typeof EmptyState>>) =>
  render(
    <EmptyState
      failed={false}
      connecting={false}
      streaming={false}
      retained={0}
      filtered={false}
      settling={false}
      intake={false}
      allHidden={false}
      onClearQuery={() => {}}
      onShowAll={() => {}}
      {...props}
    />
  );

const WROTE_NOTHING = "The previous run wrote nothing.";

/**
 * "The previous run wrote nothing." is a verdict on a run, and an empty pane
 * is not the evidence for it: the read may still be on its way, and lines
 * the run did write may have been dropped by intake or cleared by the reader.
 */
describe("an empty pane on a previous run", () => {
  /** Fails if the verdict is drawn while the read is still coming, which is how it flashed before the lines. */
  it("draws the lines to come, and no verdict, while the run is being read", () => {
    pane({ connecting: true, read: null });
    expect(screen.getByTestId("log-skeleton")).toBeInTheDocument();
    expect(screen.queryByText(WROTE_NOTHING)).toBeNull();
  });

  /** The one case the sentence is true in. Fails if a read that ended with no lines says anything else. */
  it("says the run wrote nothing once its read ended with no lines", () => {
    pane({ read: { sources: 1, lines: 0 } });
    expect(screen.getByText(WROTE_NOTHING)).toBeInTheDocument();
  });

  /** Fails if Clear turns a run that wrote into one that wrote nothing. */
  it("says the lines are gone from the pane, not that none were written, after Clear", () => {
    pane({ read: { sources: 1, lines: 240 } });
    expect(screen.queryByText(WROTE_NOTHING)).toBeNull();
    expect(screen.getByText("Nothing left to show.")).toBeInTheDocument();
    expect(screen.getByText("240 lines received.")).toBeInTheDocument();
  });

  /** Fails if a run whose every line intake rejected is called silent. */
  it("says none were kept when intake dropped every line the run wrote", () => {
    pane({ read: { sources: 1, lines: 240 }, intake: true });
    expect(screen.queryByText(WROTE_NOTHING)).toBeNull();
    expect(screen.getByText("0 lines kept.")).toBeInTheDocument();
  });

  /** Every read failed and has its own notice: no run was read to speak of. Fails if it is given a verdict. */
  it("says nothing of a run no read reached the end of", () => {
    const { container } = pane({ read: { sources: 0, lines: 0 } });
    expect(container).toBeEmptyDOMElement();
  });

  /** A read paused before its end has found nothing out. Fails if the pause reads as a verdict or as a wait. */
  it("says it is not reading when the read was stopped before its end", () => {
    pane({ read: null });
    expect(screen.queryByText(WROTE_NOTHING)).toBeNull();
    expect(screen.getByText("Not streaming.")).toBeInTheDocument();
  });
});

/**
 * "Nothing has been written since these containers started" is a verdict on
 * the containers, and an empty buffer is the evidence for it only where
 * every line written gets here and stays.
 */
describe("an empty pane on an attached stream", () => {
  const SILENT =
    "The stream is attached; nothing has been written since these containers started.";

  /** The one case the sentence is true in. */
  it("says nothing has been written where nothing was kept out or taken away", () => {
    pane({ streaming: true });
    expect(screen.getByText("No output yet.")).toBeInTheDocument();
    expect(screen.getByText(SILENT)).toBeInTheDocument();
  });

  /** Fails if a container writing hundreds of lines a second, all discarded at the source, is called silent. */
  it("says no line was kept, not that none was written, under intake", () => {
    pane({ streaming: true, intake: true, cleared: true });
    expect(screen.queryByText(SILENT)).toBeNull();
    expect(screen.getByText("No line kept yet.")).toBeInTheDocument();
    expect(
      screen.getByText(
        "The stream is attached; intake discards the lines that do not match as they arrive."
      )
    ).toBeInTheDocument();
  });

  /** Fails if Clear turns thousands of lines just on screen into containers that never wrote. */
  it("says the buffer was cleared, not that nothing was ever written, after Clear", () => {
    pane({ streaming: true, cleared: true });
    expect(screen.queryByText(SILENT)).toBeNull();
    expect(screen.getByText("The buffer was cleared.")).toBeInTheDocument();
    expect(
      screen.getByText(
        "The stream is attached; nothing has been written since."
      )
    ).toBeInTheDocument();
  });
});
