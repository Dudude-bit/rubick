import type { ReactElement } from "react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { useLocaleStore } from "@/stores/localeStore";
import { useWhatsNewStore } from "@/stores/whatsNewStore";
import { renderWithProviders } from "@/test/render";
import { WhatsNew } from "./WhatsNew";

const getAppInfo = vi.fn();
vi.mock("@/lib/commands", () => ({
  commands: { getAppInfo: () => getAppInfo() },
}));

vi.mock("@/../../CHANGELOG.md?raw", () => ({
  default: `## [4.13.0] - 2026-09-12

### Added

- **Credentials renew themselves.** Quietly, and _later_ rather than more often.
- **\`AzureIdentity\` was counted as "AzureIdentitys".** The kind's own spelling.

## [4.12.0] - 2026-09-11

### Fixed \u2014 the tab close button no longer drops the cluster

- **Files tab on a pod.**
`,
}));

const wrap = (ui: ReactElement) => renderWithProviders(ui);

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
  afterEach(() => useLocaleStore.setState({ choice: null }));

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

  /**
   * The changelog leads a bullet with a bold sentence and names a kind in code
   * inside it — line 36 of the file this parses does exactly that. A flat
   * renderer printed the backticks, so the first release the feature ever
   * showed had `\`AzureIdentity\`` on screen. Fails if the markup stops
   * nesting.
   */
  it("renders code inside a bold lead as code, not as backticks", async () => {
    useWhatsNewStore.setState({ seenVersion: "4.12.0", showing: [] });
    wrap(<WhatsNew />);
    const line = await screen.findByText(/was counted as/);
    expect(line.textContent).not.toContain("`");
    expect(line.querySelector("code")?.textContent).toBe("AzureIdentity");
  });

  /**
   * Lena's Russian What's New headed its notes "FIXED" over a date written
   * 2026-09-30, and nothing said why the notes were English. Fails if a
   * section's kind or a release's date is left in English, if a subtitle the
   * changelog wrote is lost, or if the dialog stops saying the notes are as
   * written.
   */
  it("says the headings and dates in the reader's language, and that the notes are as written", async () => {
    useLocaleStore.setState({ choice: "ru" });
    useWhatsNewStore.setState({ seenVersion: "4.11.0" });
    wrap(<WhatsNew />);
    expect(await screen.findByText("Добавлено")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Исправлено · the tab close button no longer drops the cluster"
      )
    ).toBeInTheDocument();
    expect(screen.getByText(/4\.12\.0 · 11 сент\. 2026/)).toBeInTheDocument();
    expect(screen.getByText(/как они записаны в журнале/)).toBeInTheDocument();
    expect(screen.queryByText(/2026-09-1/)).toBeNull();
  });

  /** An English reader is told nothing about the notes' language. */
  it("says nothing about the notes' language to an English reader", async () => {
    useWhatsNewStore.setState({ seenVersion: "4.12.0" });
    wrap(<WhatsNew />);
    expect(await screen.findByText("Sep 12, 2026")).toBeInTheDocument();
    expect(screen.getByText("Added")).toBeInTheDocument();
    expect(screen.queryByText(/as the changelog writes them/)).toBeNull();
  });
});
