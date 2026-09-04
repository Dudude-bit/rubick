import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { Diagnostics } from "@/generated/types";
import { EnvironmentBlocks } from "./EnvironmentBlocks";

const sample: Diagnostics = {
  shell: { outcome: "imported", shell: "/bin/zsh", adopted: 3, removed: 0 },
  searchPathIsReal: true,
  searchPath: [
    { path: "/opt/homebrew/bin", exists: true },
    { path: "~/.krew/bin", exists: false },
  ],
  // One of each state a tool can be in, because the three read differently
  // on purpose and only one of them is a fault.
  tools: [
    {
      name: "kubectl",
      path: "/opt/homebrew/bin/kubectl",
      version: "v1.31.0",
      error: null,
    },
    {
      name: "helm",
      path: "/opt/homebrew/bin/helm",
      version: null,
      error: "exec format error",
    },
    { name: "az", path: null, version: null, error: null },
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

  /**
   * A tool nobody needs is not a fault.
   *
   * Six of these are cloud CLIs. Somebody who has never touched Azure is not
   * missing `az`, and an absent-means-red rule would open this pane on four
   * red rows and hide the one that matters underneath them.
   */
  it("does not call an absent tool a fault", () => {
    render(<EnvironmentBlocks diagnostics={sample} />);
    const row = screen.getByText("az").closest("li");
    expect(row).toHaveTextContent(/not installed/i);
    expect(row?.querySelector(".text-err")).toBeNull();
  });

  /**
   * The state that has to be visible: the binary is there, so nobody will
   * think to install it, and whatever wanted it fails later saying something
   * else entirely.
   */
  it("marks a tool that is present and would not answer", () => {
    render(<EnvironmentBlocks diagnostics={sample} />);
    const row = screen.getByText("helm").closest("li");
    expect(row).toHaveTextContent(/would not say its version/i);
    expect(row?.querySelector(".text-warn")).not.toBeNull();
  });

  /** The heading counts what resolved, not what was asked about: three rows
   *  with one missing is "2 of 3", which is the number worth reading. */
  it("counts the tools that resolved", () => {
    render(<EnvironmentBlocks diagnostics={sample} />);
    expect(screen.getByText(/Tools · 2 of 3/)).toBeInTheDocument();
  });
});
