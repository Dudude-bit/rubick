import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@/lib/commands", () => ({
  commands: { forgetDiscovery: () => Promise.resolve() },
}));

import type { CapabilityState } from "@/integrations";
import { LogHistoryBar } from "./LogHistoryBar";
import type { HistoryState } from "./hooks/useLogHistory";

const capability = {
  state: "ready",
  vendor: "Loki",
  endpoint: "loki:3100",
  page: null,
  use: vi.fn(),
} as unknown as CapabilityState<"logs.history">;

function bar(history: HistoryState, onRead = vi.fn(), selected = null) {
  render(
    <LogHistoryBar
      capability={capability}
      history={history}
      stranded="the pod api-1"
      ranged
      held={0}
      keep={5000}
      selected={selected}
      isPaging={false}
      onRead={onRead}
      onReadOlder={vi.fn()}
      onClear={vi.fn()}
    />
  );
  return onRead;
}

describe("LogHistoryBar when the supplier failed", () => {
  /**
   * The failure sat in role=status and offered "Ask again" only once a range
   * had been chosen. Fails if the failure is not announced as an alert, or
   * if it offers no retry before a range was picked.
   */
  it("announces the failure and offers to ask again before any range was chosen", async () => {
    const onRead = bar({ state: "failed", reason: "502 from loki" });
    expect(screen.getByRole("alert")).toHaveTextContent("502 from loki");
    await userEvent.click(screen.getByRole("button", { name: /again/i }));
    await waitFor(() => expect(onRead).toHaveBeenCalledWith("1h"));
  });

  /** Fails if asking again forgets the range the reader chose. */
  it("asks again for the range the reader chose", async () => {
    const onRead = bar(
      { state: "failed", reason: "502" },
      vi.fn(),
      "6h" as never
    );
    await userEvent.click(screen.getByRole("button", { name: /again/i }));
    await waitFor(() => expect(onRead).toHaveBeenCalledWith("6h"));
  });
});

describe("LogHistoryBar range picker", () => {
  /** Fails if the ranges stop being a pressed-state control that reads the chosen window. */
  it("reads the window a pressed range names", async () => {
    const onRead = bar({ state: "idle" });
    await userEvent.click(screen.getByRole("button", { name: "6h" }));
    expect(onRead).toHaveBeenCalledWith("6h");
  });
});
