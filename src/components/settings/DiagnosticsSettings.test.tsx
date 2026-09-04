import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Diagnostics } from "@/generated/types";

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

const empty: Diagnostics = {
  shell: { outcome: "imported", shell: "/bin/zsh", adopted: 3, removed: 0 },
  searchPathIsReal: true,
  searchPath: [{ path: "/opt/homebrew/bin", exists: true }],
  tools: [
    {
      name: "kubectl",
      path: "/usr/local/bin/kubectl",
      version: "v1.31.0",
      error: null,
    },
  ],
  plugins: [],
  contexts: [],
  kubeconfig: null,
  app: {
    version: "4.0.1",
    os: "macos aarch64",
    configPath: null,
    logDestination: "stdout",
  },
  findings: [],
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
