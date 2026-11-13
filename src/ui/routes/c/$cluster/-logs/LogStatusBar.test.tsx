import { describe, expect, it, vi } from "vite-plus/test";
import { render, screen } from "@testing-library/react";

import { TooltipProvider } from "@/components/ui/tooltip";
import { LogStatusBar } from "./LogStatusBar";
import type { StreamedLogLine } from "./types";

const line = (id: number, epoch: number) =>
  ({
    id,
    epoch,
    message: `line ${id}`,
    container: "app",
    pod: "api-1",
  }) as unknown as StreamedLogLine;

function bar(logs: StreamedLogLine[]) {
  render(
    <TooltipProvider>
      <LogStatusBar
        logs={logs}
        retained={logs.length}
        limit={5000}
        frozen={null}
        frozenLines={0}
        onThaw={vi.fn()}
        shownCount={logs.length}
        settling={false}
        hiddenCount={0}
        intake={[]}
        intakeFrom={0}
        unfilteredFrom={0}
        isStreaming
        followed={{ followed: 1, total: 1 } as never}
      />
    </TooltipProvider>
  );
}

describe("the log footer's line rate", () => {
  /**
   * Two lines 65 ms apart printed "15 lines/s". Fails if a rate is quoted
   * over a window shorter than a second.
   */
  it("quotes no rate from lines that arrived within a fraction of a second", () => {
    bar([line(1, 1_000_000), line(2, 1_000_065)]);
    expect(screen.queryByText(/\/s/)).toBeNull();
  });

  /** Fails if the rate is lost for a window long enough to measure. */
  it("quotes a rate over a window that spans seconds", () => {
    bar([line(1, 1_000_000), line(2, 1_002_000), line(3, 1_004_000)]);
    expect(screen.getByText(/\/s/)).toBeInTheDocument();
  });
});
