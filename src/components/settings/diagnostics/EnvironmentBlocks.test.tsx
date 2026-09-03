import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { Diagnostics } from "@/generated/types";
import { EnvironmentBlocks } from "./EnvironmentBlocks";

const sample: Diagnostics = {
  shell: { outcome: "imported", shell: "/bin/zsh", adopted: 3, removed: 0 },
  searchPath: [
    { path: "/opt/homebrew/bin", exists: true },
    { path: "~/.krew/bin", exists: false },
  ],
  plugins: [
    { name: "kubectl-oidc_login", path: null, requiredBy: ["context-1"] },
  ],
  contexts: [
    {
      context: "context-1",
      method: "exec",
      command: "kubectl",
      commandPath: "/opt/homebrew/bin/kubectl",
    },
  ],
  kubeconfig: { path: "~/.kube/config", parseError: null, contextCount: 1 },
  app: {
    version: "4.0.1",
    os: "macos aarch64",
    configPath: "~/Library/Application Support/k8s-gui/config.toml",
    logDestination: "stdout",
  },
  findings: [],
};

describe("EnvironmentBlocks", () => {
  /**
   * The search path is a guess whenever the shell did not answer, and the
   * directories below it are then the wrong thing to check one by one. The
   * sentence has to sit above them, and it has to change tone: a reader
   * skimming for what is wrong reads colour before words.
   */
  it("says where the search path came from, and warns when it is a guess", () => {
    const { rerender } = render(<EnvironmentBlocks diagnostics={sample} />);
    const answered = screen.getByText(/\/bin\/zsh/);
    expect(answered).toHaveTextContent("3 variables changed, 0 removed");
    expect(answered).not.toHaveClass("text-warn");

    rerender(
      <EnvironmentBlocks
        diagnostics={{
          ...sample,
          shell: { outcome: "timedOut", shell: "/bin/zsh", seconds: 30 },
        }}
      />
    );
    expect(screen.getByText(/did not print its environment/)).toHaveClass(
      "text-warn"
    );
  });

  it("marks a search path directory that is not there", () => {
    render(<EnvironmentBlocks diagnostics={sample} />);
    expect(screen.getByText("~/.krew/bin").closest("li")).toHaveTextContent(
      /not there/i
    );
  });

  it("names who needs a plugin that is missing", () => {
    render(<EnvironmentBlocks diagnostics={sample} />);
    const row = screen.getByText("kubectl-oidc_login").closest("li");
    expect(row).toHaveTextContent("not found");
    expect(row).toHaveTextContent("context-1");
  });

  it("says a kubeconfig was never loaded rather than showing an empty path", () => {
    // An empty path and an unread file look the same and mean different
    // things — the same rule the Integrations pane already follows.
    render(<EnvironmentBlocks diagnostics={{ ...sample, kubeconfig: null }} />);
    expect(screen.getByText(/none loaded yet/i)).toBeInTheDocument();
  });
});
