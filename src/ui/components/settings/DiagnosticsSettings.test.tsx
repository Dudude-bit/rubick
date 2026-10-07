import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { Diagnostics } from "@/generated/types";
import { usePrivacyStore } from "@/stores/privacyStore";

const collectDiagnostics = vi.fn();
vi.mock("@/lib/commands", () => ({
  commands: {
    collectDiagnostics: (redact: boolean) => collectDiagnostics(redact),
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
