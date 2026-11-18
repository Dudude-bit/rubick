import { describe, expect, it } from "vite-plus/test";

import { setHostOs } from "./platform";
import { cliLine, cliPipe, kubectlGet } from "./kubectl";

const at = { context: "default", files: "/home/me/.kube/k3s.yaml" };
const on = "KUBECONFIG=/home/me/.kube/k3s.yaml kubectl --context default";

describe("the kubectl command for an object", () => {
  it("names a built-in kind by its own word, with the namespace", () => {
    expect(
      kubectlGet({ kind: "Deployment", name: "web", namespace: "shop" }, at)
    ).toBe(`${on} get deployment web -n shop`);
  });

  it("leaves the namespace off a cluster-scoped object", () => {
    expect(
      kubectlGet({ kind: "Node", name: "worker-1", namespace: null }, at)
    ).toBe(`${on} get node worker-1`);
  });

  /** Istio ships a `gateways` too; the bare word reads whichever kubectl finds first. */
  it("spells a Gateway API kind with its group", () => {
    expect(
      kubectlGet({ kind: "Gateway", name: "edge", namespace: "infra" }, at)
    ).toBe(`${on} get gateways.gateway.networking.k8s.io edge -n infra`);
  });

  /** A kind the registry cannot spell gets no command rather than a guessed one. */
  it("offers nothing for a kind it does not know", () => {
    expect(kubectlGet({ kind: "Application", name: "shop" }, at)).toBeNull();
  });
});

describe("a line the app hands out to run", () => {
  /**
   * Two kubeconfig files can each call a cluster `default`. Fails if a line
   * leaves out the context or the files the app read it from, which sends
   * the terminal's kubectl or helm to its own cluster of that name.
   */
  it("names the cluster on screen and the files it was read from", () => {
    expect(cliLine("helm", at, "list -n shop")).toBe(
      "KUBECONFIG=/home/me/.kube/k3s.yaml helm list -n shop --kube-context default"
    );
    expect(
      cliLine(
        "kubectl",
        { context: "my cluster's prod", files: "/Users/me/My Files/config" },
        "get pods"
      )
    ).toBe(
      "KUBECONFIG='/Users/me/My Files/config' kubectl --context 'my cluster'\\''s prod' get pods"
    );
  });

  /** Fails if a context or files not known yet leave the flag out instead of a stand-in to fill. */
  it("puts a stand-in where the cluster is not known", () => {
    expect(cliLine("kubectl", { context: null, files: null }, "get pods")).toBe(
      "KUBECONFIG=FILES kubectl --context CONTEXT get pods"
    );
  });
});

describe("a line for PowerShell", () => {
  /**
   * `KUBECONFIG=… kubectl` is a POSIX form: pasted into PowerShell, the
   * Windows terminal, it runs nothing. Fails if a Windows line is written
   * in it, or leaves the terminal's KUBECONFIG changed after it.
   */
  it("sets the files around the command and puts back what was there", () => {
    expect(
      cliLine(
        "kubectl",
        { context: "default", files: "C:\\Users\\me\\.kube\\k3s.yaml" },
        "get pods",
        "powershell"
      )
    ).toBe(
      "& { $was = $env:KUBECONFIG; $env:KUBECONFIG = 'C:\\Users\\me\\.kube\\k3s.yaml'; try { kubectl --context 'default' get pods } finally { $env:KUBECONFIG = $was } }"
    );
    expect(
      cliLine("helm", { context: "o'brien", files: null }, "list", "powershell")
    ).toBe(
      "& { $was = $env:KUBECONFIG; $env:KUBECONFIG = 'FILES'; try { helm list --kube-context 'o''brien' } finally { $env:KUBECONFIG = $was } }"
    );
  });

  /** On Windows a line is written for PowerShell without being asked; elsewhere for a POSIX shell. */
  it("writes for PowerShell on a Windows host and for a POSIX shell on any other", () => {
    try {
      setHostOs("windows");
      expect(cliLine("kubectl", at, "get pods")).toMatch(/^& \{ \$was = /);
    } finally {
      setHostOs("linux");
    }
    expect(cliLine("kubectl", at, "get pods")).toBe(`${on} get pods`);
  });

  /**
   * PowerShell ends a single-quoted literal at a typographic quote too: a
   * path through O’Brien's home closed the literal there, and the rest of
   * the name was read as code. Fails if any of the four is left single.
   */
  it("doubles every quote PowerShell ends a literal at, typographic ones too", () => {
    expect(
      cliLine(
        "kubectl",
        { context: "a‘b‚c‛d", files: "C:\\Users\\O’Brien\\.kube\\config" },
        "get pods",
        "powershell"
      )
    ).toContain(
      "$env:KUBECONFIG = 'C:\\Users\\O’’Brien\\.kube\\config'; try { kubectl --context 'a‘‘b‚‚c‛‛d' get pods }"
    );
  });

  /**
   * Windows PowerShell 5.1 strips a double quote inside an argument it hands
   * kubectl: `ops"blue"` arrives as `opsblue`, which may be another context
   * in the same kubeconfig. Fails if such a name, or a spaced one ending in
   * a backslash, is written into the line rather than the stand-in.
   */
  it("puts the stand-in for a context PowerShell 5.1 cannot hand kubectl whole", () => {
    const line = (context: string) =>
      cliLine(
        "kubectl",
        { context, files: "C:\\k\\config" },
        "get pods",
        "powershell"
      );
    expect(line('ops"blue"')).toContain("kubectl --context 'CONTEXT' get pods");
    expect(line("lab one\\")).toContain("kubectl --context 'CONTEXT' get pods");
    expect(line("my cluster")).toContain(
      "kubectl --context 'my cluster' get pods"
    );
    expect(
      cliLine(
        "kubectl",
        { context: 'ops"blue"', files: "/k" },
        "get pods",
        "posix"
      )
    ).toContain(`--context 'ops"blue"' get pods`);
  });

  /**
   * Each stage of a pipe setting the files for itself races the others over
   * the one environment, and the last to put it back wins. Fails if a pipe
   * sets them more than once, or a POSIX pipe leaves a stage without them.
   */
  it("sets the files once around a whole pipe, and on each POSIX command", () => {
    const steps = [
      ["kubectl", "get crontabs -o json"],
      ["kubectl", "replace -f -"],
    ] as const;
    const shell = cliPipe(at, steps, "powershell");
    expect(shell.match(/\$env:KUBECONFIG = '/g)).toHaveLength(1);
    // 5.1 hands the second program ASCII unless told otherwise: a café read
    // back is written to the cluster as caf?. UTF-8 is set before the pipe,
    // inside the try, and the console's own put back after it.
    expect(shell).toMatch(
      /try \{ \$env:KUBECONFIG = '[^']*'; \$OutputEncoding = \[Console\]::OutputEncoding = New-Object Text\.UTF8Encoding \$false; kubectl /
    );
    expect(shell).toContain(
      "finally { $env:KUBECONFIG = $was; [Console]::OutputEncoding = $console }"
    );
    expect(shell).toContain(
      "kubectl --context 'default' get crontabs -o json | kubectl --context 'default' replace -f - }"
    );
    expect(cliPipe(at, steps, "posix")).toBe(
      `${on} get crontabs -o json | ${on} replace -f -`
    );
  });
});
