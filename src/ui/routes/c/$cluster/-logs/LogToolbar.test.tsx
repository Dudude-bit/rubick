import { describe, expect, it, vi } from "vite-plus/test";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { renderWithRouter } from "@/test/render";
import { LogToolbar } from "./LogToolbar";

const noop = vi.fn();

function toolbar(over: Partial<Parameters<typeof LogToolbar>[0]> = {}) {
  return (
    <LogToolbar
      terms={[]}
      draft=""
      onDraftChange={noop}
      onAddTerm={noop}
      onRemoveTerm={noop}
      intake={new Set()}
      onToggleIntake={noop}
      frozen={null}
      onToggleFreeze={noop}
      fields={new Map() as never}
      limit={5000}
      onLimitChange={noop}
      collapseRepeats={false}
      onCollapseRepeatsChange={noop}
      previousRun={false}
      offerPreviousRun={false}
      onPreviousRunToggle={noop}
      viewMode="compact"
      onViewModeChange={noop}
      isStreaming={false}
      isConnecting={false}
      isPaused={false}
      followed={{ followed: 1, total: 1 } as never}
      stoppedFollow="resumes"
      autoScroll
      isAtBottom
      onAutoScrollToggle={noop}
      onClearLogs={noop}
      onCopyLogs={noop}
      onDownloadLogs={noop}
      onToggleStreaming={noop}
      stripMode={"hidden" as never}
      onStripModeChange={noop}
      {...over}
    />
  );
}

describe("the log toolbar's stream button while the stream connects", () => {
  /**
   * The button was disabled while connecting, so a hanging connect to an
   * unreachable node could only be waited out. Fails if it is disabled again,
   * or if pressing it does not reach the toggle that stops the stream.
   */
  it("stays pressable so a hanging connect can be stopped", async () => {
    const onToggleStreaming = vi.fn();
    await renderWithRouter(toolbar({ isConnecting: true, onToggleStreaming }));
    const button = screen.getByRole("button", { name: /Connecting/ });
    expect(button).toBeEnabled();
    await userEvent.click(button);
    expect(onToggleStreaming).toHaveBeenCalledTimes(1);
  });
});
