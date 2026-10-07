import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vite-plus/test";

import type { Diagnostics } from "@/generated/types";
import { useLocaleStore } from "@/stores/localeStore";
import { EnvironmentBlocks } from "./EnvironmentBlocks";

afterEach(() => useLocaleStore.setState({ choice: "en" }));

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
    },
    {
      name: "helm",
      path: "/opt/homebrew/bin/helm",
      version: null,
    },
    { name: "az", path: null, version: null },
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
    logDestination: "/Users/someone/Library/Logs/com.k8s-gui.app/rubick.log",
  },
  findings: [],
  connections: [
    {
      context: "context-1",
      at: "2026-09-07T07:00:00Z",
      direct: {
        state: "failed",
        error: "Unauthorized",
        failure: "credentials",
      },
      proxy: {
        state: "failed",
        error: "kubectl proxy exited: exit status 1",
        stdout: "",
        stderr: 'error: unknown command "oidc-login" for "kubectl"',
        kubectl: "/opt/homebrew/bin/kubectl",
      },
    },
  ],
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
    expect(answered).toHaveTextContent("Variables changed: 3, removed: 0");
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
  /** Settings said "helm не найден" and Diagnostics "не установлен" for one fact; fails if the two words part again. */
  it("says an absent tool is not found, in the words Settings uses", () => {
    useLocaleStore.setState({ choice: "ru" });
    render(<EnvironmentBlocks diagnostics={sample} />);
    const row = screen.getByText("az").closest("li");
    expect(row).toHaveTextContent("не найден");
    expect(row).not.toHaveTextContent("не установлен");
  });

  it("does not call an absent tool a fault", () => {
    render(<EnvironmentBlocks diagnostics={sample} />);
    const row = screen.getByText("az").closest("li");
    expect(row).toHaveTextContent(/not found/i);
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

  /** With names and paths hidden Lena read "kubectl kubectl v1.37.1". Fails if a path that is only the name is printed again. */
  it("does not repeat a tool's name where its hidden path would be", () => {
    render(
      <EnvironmentBlocks
        diagnostics={{
          ...sample,
          tools: [{ name: "kubectl", path: "kubectl", version: "v1.37.1" }],
        }}
      />
    );
    const row = screen.getByText("v1.37.1").closest("li");
    expect(row).toHaveTextContent(/^kubectlv1\.37\.1$/);
  });

  /** The heading counts what resolved, not what was asked about: three rows
   *  with one missing is "2 of 3", which is the number worth reading. */
  it("counts the tools that resolved", () => {
    render(<EnvironmentBlocks diagnostics={sample} />);
    expect(screen.getByText(/Tools · 2 of 3/)).toBeInTheDocument();
  });

  /**
   * Would break if the caveat stopped reaching the tools.
   *
   * Every "not found" below rests on the search path above, and without
   * the shell's answer that path is the well-known directories and nothing a
   * profile adds. Stated over the tool list as well as over the search path,
   * because a reader scanning tools does not scroll up for it — and stated in
   * the same words, so a wording fix is one place.
   */
  it("says the search path was a guess over the tools, not only over the path", () => {
    render(
      <EnvironmentBlocks
        diagnostics={{
          ...sample,
          searchPathIsReal: false,
          shell: { outcome: "timedOut", shell: "/bin/zsh", seconds: 30 },
        }}
      />
    );

    // Twice: once over the directories, once over the tools that were looked
    // for in them.
    expect(screen.getAllByText(/\/bin\/zsh/)).toHaveLength(2);
  });

  /** And not at all when the shell did answer. */
  it("says nothing of the sort when the path is real", () => {
    render(<EnvironmentBlocks diagnostics={sample} />);
    expect(screen.queryAllByText(/did not|не ответила/i)).toHaveLength(0);
  });

  /**
   * The whole point of the file: "send me the log" has to have an answer a
   * reader can act on. The path is the answer, and this is the only screen
   * that names it.
   */
  it("names the file this run is writing to", () => {
    render(<EnvironmentBlocks diagnostics={sample} />);
    expect(
      screen.getByText(/Library\/Logs\/com\.k8s-gui\.app\/rubick\.log/)
    ).toBeInTheDocument();
  });

  /**
   * No writable log directory is its own state. Leaving the line out reads
   * as "logs go somewhere I did not scroll to", and a blank where a path
   * belongs is the third state collapsing into the second.
   */
  it("says there is no file rather than showing an empty path", () => {
    render(
      <EnvironmentBlocks
        diagnostics={{
          ...sample,
          app: { ...sample.app, logDestination: null },
        }}
      />
    );
    expect(screen.getByText(/no log file/i)).toBeInTheDocument();
    // The path line is gone, not blank: `Logs:` with nothing after it reads
    // as a destination the reader failed to scroll to.
    expect(screen.queryByText(/^Logs:/)).toBeNull();
  });
});

describe("the second way in", () => {
  /** "Works in kubectl" is the report half these tickets open with; what kubectl itself said is the half that closes them. */
  it("shows both paths of the last attempt, with kubectl's own words", () => {
    render(<EnvironmentBlocks diagnostics={sample} />);
    expect(screen.getByText("Unauthorized")).toBeInTheDocument();
    expect(
      screen.getByText(/unknown command "oidc-login"/)
    ).toBeInTheDocument();
  });

  /** A blank line where the proxy should be reads as "it was fine"; the reason it was never tried has to be said. */
  it("says when there was no kubectl to fall back to", () => {
    render(
      <EnvironmentBlocks
        diagnostics={{
          ...sample,
          connections: [
            { ...sample.connections[0], proxy: { state: "noKubectl" } },
          ],
        }}
      />
    );
    expect(
      screen.getByText("no kubectl on the search path")
    ).toBeInTheDocument();
  });
});

describe("the time of a connection attempt", () => {
  /**
   * Lena read "2026-10-06T22:01:25.123456789Z" among dates drawn in her own
   * language and zone. Fails if the raw timestamp reaches the screen.
   */
  it("is drawn as every other date is, not as the backend wrote it", () => {
    useLocaleStore.setState({ choice: "ru" });
    render(
      <EnvironmentBlocks
        diagnostics={{
          ...sample,
          connections: [
            { ...sample.connections[0], at: "2026-10-06T22:01:25.123456789Z" },
          ],
        }}
      />
    );
    expect(document.body).toHaveTextContent(/2026 г\./);
    expect(document.body).not.toHaveTextContent(/T\d\d:\d\d|123456789|\dZ\b/);
  });
});
