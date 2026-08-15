import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { Diagnostics } from "@/generated/types";
import { EnvironmentBlocks } from "./EnvironmentBlocks";

const sample: Diagnostics = {
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
