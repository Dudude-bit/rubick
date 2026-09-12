import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { useWhatsNewStore } from "@/stores/whatsNewStore";
import { WhatsNew } from "./WhatsNew";

const getAppInfo = vi.fn();
vi.mock("@/lib/commands", () => ({
  commands: { getAppInfo: () => getAppInfo() },
}));

vi.mock("../../../CHANGELOG.md?raw", () => ({
  default: `## [4.13.0] - 2026-09-12

### Added

- **Credentials renew themselves.** Quietly, and _later_ rather than more often.

## [4.12.0] - 2026-09-11

### Added

- **Files tab on a pod.**
`,
}));

const wrap = (ui: ReactNode) =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      {ui}
    </QueryClientProvider>
  );

describe("WhatsNew", () => {
  beforeEach(() => {
    getAppInfo.mockResolvedValue({
      version: "4.13.0",
      name: "Rubick",
      tauriVersion: "2",
      os: "linux",
    });
    useWhatsNewStore.setState({ seenVersion: null, showing: [] });
  });

  /** Issue #178: nobody who skips GitHub ever saw the notes. Would break if the update stopped opening them, or if a first launch started to. */
  it("opens the notes once after an update, and not on a first launch", async () => {
    useWhatsNewStore.setState({ seenVersion: "4.12.0" });
    wrap(<WhatsNew />);
    expect(await screen.findByText("What's new in 4.13.0")).toBeInTheDocument();
    expect(
      screen.getByText(/Credentials renew themselves/)
    ).toBeInTheDocument();
    expect(screen.getByText("later").tagName).toBe("EM");
    expect(screen.queryByText(/Files tab on a pod/)).toBeNull();
    await userEvent.click(
      screen.getAllByRole("button", { name: "Close" }).at(-1)!
    );
    await waitFor(() =>
      expect(screen.queryByText("What's new in 4.13.0")).toBeNull()
    );
    expect(useWhatsNewStore.getState().seenVersion).toBe("4.13.0");
  });

  it("records the first launch without opening anything", async () => {
    wrap(<WhatsNew />);
    await waitFor(() =>
      expect(useWhatsNewStore.getState().seenVersion).toBe("4.13.0")
    );
    expect(screen.queryByText(/What's new/)).toBeNull();
  });

  it("shows every release skipped by a reader two versions behind", async () => {
    useWhatsNewStore.setState({ seenVersion: "4.11.0" });
    wrap(<WhatsNew />);
    expect(await screen.findByText("What's new in 4.13.0")).toBeInTheDocument();
    expect(screen.getByText("Everything since 4.12.0")).toBeInTheDocument();
    expect(screen.getByText(/Files tab on a pod/)).toBeInTheDocument();
  });
});
