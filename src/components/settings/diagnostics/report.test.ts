import { describe, expect, it } from "vitest";

import type { Diagnostics } from "@/generated/types";
import { asMarkdown } from "./report";

const base: Diagnostics = {
  shell: { outcome: "imported", shell: "/bin/zsh", adopted: 3, removed: 0 },
  searchPathIsReal: true,
  searchPath: [
    { path: "/opt/homebrew/bin", exists: true },
    { path: "~/.krew/bin", exists: false },
  ],
  tools: [
    {
      name: "kubectl",
      path: "/usr/local/bin/kubectl",
      version: "v1.31.0",
    },
  ],
  plugins: [
    { name: "kubectl-oidc_login", path: null, requiredBy: ["context-1"] },
  ],
  contexts: [
    {
      context: "context-1",
      method: "exec",
      command: "kubectl",
      commandPath: null,
    },
  ],
  kubeconfig: { path: "~/.kube/config", parseError: null, contextCount: 1 },
  app: {
    version: "4.0.1",
    os: "macos aarch64",
    configPath: null,
    logDestination: "stdout",
  },
  findings: [
    {
      severity: "blocking",
      title: "kubectl-oidc_login is not installed",
      detail: "The context context-1 needs it.",
      subject: "context-1",
      aboutShell: false,
    },
  ],
};

describe("asMarkdown", () => {
  it("leads with the findings, because the reader of a paste wants the conclusion", () => {
    const out = asMarkdown(base);
    expect(out.indexOf("### Findings")).toBeLessThan(
      out.indexOf("### Search path")
    );
    expect(out).toContain("**kubectl-oidc_login is not installed**");
  });

  it("marks what is absent rather than leaving a blank the reader must interpret", () => {
    const out = asMarkdown(base);
    expect(out).toContain("`~/.krew/bin` — not there");
    expect(out).toContain("`kubectl-oidc_login` — not found");
    expect(out).toContain("not found");
  });

  it("says nothing needs attention rather than printing an empty heading", () => {
    const out = asMarkdown({ ...base, findings: [] });
    expect(out).toContain("Nothing needs attention.");
  });

  it("says a kubeconfig was never loaded", () => {
    const out = asMarkdown({ ...base, kubeconfig: null });
    expect(out).toContain("None loaded.");
  });

  /**
   * The first question a maintainer asks about "plugin not found" is
   * whether the shell was read at all, so the answer goes above the search
   * path it explains.
   */
  it("says whether the shell answered, above the search path", () => {
    const out = asMarkdown({
      ...base,
      shell: { outcome: "noAnswer", shell: "/bin/tcsh", exit: 1 },
    });
    expect(out.indexOf("### Shell")).toBeLessThan(
      out.indexOf("### Search path")
    );
    expect(out).toContain("/bin/tcsh exited with code 1");
  });

  /**
   * Three states, three lines.
   *
   * The paste is read by somebody who cannot see the machine, so "kubectl is
   * there" has to be distinguishable from "kubectl is there and would not say
   * which one it is" — the second is the answer to half the reports that go
   * anywhere, and both render as a present binary.
   */
  it("tells an absent tool from one that answered nothing", () => {
    const out = asMarkdown({
      ...base,
      tools: [
        {
          name: "kubectl",
          path: "/usr/local/bin/kubectl",
          version: "v1.31.0",
        },
        {
          name: "helm",
          path: "/usr/local/bin/helm",
          version: null,
        },
        { name: "az", path: null, version: null },
      ],
    });

    expect(out).toContain("`kubectl` — /usr/local/bin/kubectl · v1.31.0");
    expect(out).toContain("`helm` — /usr/local/bin/helm · no version reported");
    expect(out).toContain("`az` — not installed");
  });
});
