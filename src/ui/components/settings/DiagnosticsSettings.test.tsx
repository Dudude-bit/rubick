import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { Diagnostics } from "@/generated/types";
import { usePrivacyStore } from "@/stores/privacyStore";

const collectDiagnostics = vi.fn();
/** A failed read, outside the spy: a spy reset earlier in the file reports the rejection it returns as the test's own failure. */
let refusedWith: unknown = null;
vi.mock("@/lib/commands", () => ({
  commands: {
    collectDiagnostics: (redact: boolean) =>
      refusedWith ? Promise.reject(refusedWith) : collectDiagnostics(redact),
  },
}));

const writeText = vi.fn();
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: (text: string) => writeText(text),
}));

const { DiagnosticsSettings } = await import("./DiagnosticsSettings");

beforeEach(() => usePrivacyStore.setState({ hidePaths: true }));

const empty: Diagnostics = {
  shell: { outcome: "imported", shell: "/bin/zsh", adopted: 3, removed: 0 },
  searchPathIsReal: true,
  searchPath: [{ path: "/opt/homebrew/bin", exists: true }],
  tools: [
    {
      name: "kubectl",
      path: "/usr/local/bin/kubectl",
      version: "v1.31.0",
    },
  ],
  plugins: [],
  contexts: [],
  kubeconfig: null,
  app: {
    version: "4.0.1",
    os: "macos aarch64",
    configPath: null,
    logDestination: "/Users/someone/Library/Logs/com.k8s-gui.app/rubick.log",
  },
  findings: [],
  connections: [],
};

function renderPane() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <DiagnosticsSettings />
    </QueryClientProvider>
  );
}

describe("DiagnosticsSettings", () => {
  beforeEach(() => {
    collectDiagnostics.mockReset().mockResolvedValue(empty);
    writeText.mockReset();
  });

  it("reads redacted, because the button beside it copies what it read", async () => {
    renderPane();
    await waitFor(() => expect(collectDiagnostics).toHaveBeenCalled());
    expect(collectDiagnostics).toHaveBeenCalledWith(true);
  });

  it("re-reads unredacted only when the reader turns redaction off", async () => {
    const user = userEvent.setup();
    renderPane();
    await waitFor(() => expect(collectDiagnostics).toHaveBeenCalled());

    await user.click(screen.getByRole("checkbox", { name: /redact/i }));
    await waitFor(() => expect(collectDiagnostics).toHaveBeenCalledWith(false));
  });

  /**
   * The box hid paths in this report only, so the Helm page beside it still
   * printed Lena's home. Fails if the box stops being the one every other
   * screen reads.
   */
  it("is the box every screen that prints a path follows", async () => {
    const user = userEvent.setup();
    renderPane();
    expect(
      screen.getByText(/Applies to every path from this computer/)
    ).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: /redact/i }));
    expect(usePrivacyStore.getState().hidePaths).toBe(false);
  });

  /**
   * Sam's recordings, taken from this page, counted collectDiagnostics at a
   * quarter second every eight among the app's own numbers. Fails if the
   * page reads the machine again on a timer, or not when asked.
   */
  it("reads the machine on open and when asked, never on a timer", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderPane();
      await waitFor(() => expect(collectDiagnostics).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(collectDiagnostics).toHaveBeenCalledTimes(1);

      fireEvent.click(
        await screen.findByRole("button", { name: /read again/i })
      );
      await waitFor(() => expect(collectDiagnostics).toHaveBeenCalledTimes(2));
      expect(screen.getByText(/^Read at /)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  /** A read asked for again that failed left the last read on screen as if it were the new one. Fails if the failure is not said beside it. */
  it("says a read asked for again failed, and which read is on screen", async () => {
    renderPane();
    await screen.findByText(/^Read at /);
    refusedWith = { code: "INTERNAL", message: "spawn failed" };
    try {
      fireEvent.click(screen.getByRole("button", { name: /read again/i }));
      expect(
        await screen.findByText(
          /^Could not read again\. This is the read from /
        )
      ).toHaveClass("text-err");
    } finally {
      refusedWith = null;
    }
  });

  it("copies a report that names the version", async () => {
    const user = userEvent.setup();
    renderPane();
    await waitFor(() => expect(collectDiagnostics).toHaveBeenCalled());

    await user.click(
      await screen.findByRole("button", { name: /copy diagnostics/i })
    );
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(writeText.mock.calls[0][0]).toContain("4.0.1");
  });
});

/** Marco's machine, read plain and read with names and paths hidden. */
function marcos(redact: boolean): Diagnostics {
  const home = redact ? "~" : "/home/marco";
  return {
    ...empty,
    searchPath: [{ path: `${home}/.local/bin`, exists: true }],
    app: {
      ...empty.app,
      configPath: `${home}/.config/k8s-gui/config.toml`,
      logDestination: `${home}/.local/share/com.k8s-gui.app/logs/rubick.log`,
    },
  };
}

const copy = () => screen.getByRole("button", { name: /copy diagnostics/i });
const box = () => screen.getByRole("checkbox", { name: /redact/i });
const searchPath = () =>
  screen.getByText(/^Search path/).closest("details") as HTMLDetailsElement;

describe("DiagnosticsSettings' redact names and paths box", () => {
  beforeEach(() => writeText.mockReset());

  /**
   * Lena opened the sections, unticked the box to compare and every section
   * snapped shut. Fails if a toggle loses the sections the reader opened.
   */
  it("keeps the open sections open across a toggle", async () => {
    collectDiagnostics
      .mockReset()
      .mockImplementation(async (redact: boolean) => marcos(redact));
    renderPane();
    await screen.findByText("~/.local/bin");
    searchPath().open = true;

    fireEvent.click(box());
    await screen.findByText("/home/marco/.local/bin");
    expect(searchPath().open).toBe(true);
  });

  /**
   * Ticking the box again, once the first redacted read has been dropped,
   * shows the plain read until the hidden one lands. Fails if Copy hands
   * over that plain read while the box says redact.
   */
  it("copies nothing while the read on screen is not the one the box asks for", async () => {
    let answer: (d: Diagnostics) => void = () => {};
    collectDiagnostics
      .mockReset()
      .mockImplementation(async (redact: boolean) =>
        redact && collectDiagnostics.mock.calls.length > 1
          ? new Promise<Diagnostics>((resolve) => (answer = resolve))
          : marcos(redact)
      );
    render(
      <QueryClientProvider
        client={
          new QueryClient({
            defaultOptions: { queries: { retry: false, gcTime: 0 } },
          })
        }
      >
        <DiagnosticsSettings />
      </QueryClientProvider>
    );
    await screen.findByText("~/.local/bin");
    fireEvent.click(box());
    await screen.findByText("/home/marco/.local/bin");

    fireEvent.click(box());
    await waitFor(() => expect(collectDiagnostics).toHaveBeenCalledTimes(3));
    fireEvent.click(copy());
    expect(writeText).not.toHaveBeenCalled();

    answer(marcos(true));
    await waitFor(() => expect(copy()).toBeEnabled());
    fireEvent.click(copy());
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0][0]).not.toContain("marco");
  });
});

describe("DiagnosticsSettings before the machine is read", () => {
  beforeEach(() => collectDiagnostics.mockReset());

  /**
   * Marco aimed at Start and hit nothing: the environment blocks landed and
   * pushed it 300 px down. Fails if the page holds less room for the blocks
   * while reading than they take once read, or says all clear before it read.
   */
  it("holds a row for every environment block while it reads", async () => {
    let answer: (value: Diagnostics) => void = () => {};
    collectDiagnostics.mockReturnValue(
      new Promise<Diagnostics>((resolve) => (answer = resolve))
    );
    const { container } = renderPane();
    const reading = screen.getByTestId("diagnostics-reading");
    const rows = reading.querySelectorAll(".border-t").length;
    expect(screen.queryByText(/No problems found/)).toBeNull();
    answer(empty);
    await waitFor(() =>
      expect(screen.queryByTestId("diagnostics-reading")).toBeNull()
    );
    expect(container.querySelectorAll("details")).toHaveLength(rows);
  });

  /** A machine not yet read is not one with no problems; fails if the page says all clear before, or instead of, an answer. */
  it("says all clear only once read, and says a failed read failed", async () => {
    refusedWith = { code: "INTERNAL", message: "spawn failed" };
    renderPane();
    expect(
      await screen.findByText(
        "Could not read what this app can see of the machine."
      )
    ).toBeInTheDocument();
    expect(screen.getByText("spawn failed")).toBeInTheDocument();
    expect(screen.queryByText(/No problems found/)).toBeNull();
    refusedWith = null;
  });
});
