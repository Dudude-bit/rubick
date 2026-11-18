import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { commands } from "@/lib/commands";
import { errorToShow } from "@/lib/error-utils";
import { queryKeys } from "@/lib/query-keys";
import { kindFacts } from "@/lib/resource-registry";
import { isWindows } from "@/lib/platform";
import { useClusterStore } from "@/stores/clusterStore";

/**
 * Where a line the app hands out acts: the cluster on screen, and the
 * kubeconfig files the app read it from. `null` where that is not known;
 * the line then carries a stand-in the reader has to fill.
 */
export interface CliTarget {
  context: string | null;
  files: string | null;
  /** Why the files could not be named, where the last ask failed. */
  why?: string | null;
  /** Asks for the files again. */
  retry?: () => void;
}

/** A shell word as written, quoted where the shell would read it otherwise. */
export const word = (text: string) =>
  /^[\w.:/@=+-]+$/.test(text) ? text : `'${text.replaceAll("'", `'\\''`)}'`;

/** A PowerShell literal: single-quoted, a quote inside written twice. */
const psWord = (text: string) => `'${text.replaceAll("'", "''")}'`;

/** The shell a line is written for: Windows opens PowerShell. */
export type Shell = "posix" | "powershell";
const hostShell = (): Shell => (isWindows() ? "powershell" : "posix");

type Step = readonly [tool: "kubectl" | "helm", args: string];

const run = ([tool, args]: Step, context: string) =>
  tool === "kubectl"
    ? `kubectl --context ${context} ${args}`
    : `helm ${args} --kube-context ${context}`;

/**
 * Every kubectl or helm line the app gives the reader to copy or to run.
 * Without the context the tool acts on its kubeconfig's current one, and
 * without the files on whatever the terminal's file calls by that name:
 * k3s calls every cluster `default`. An answer from there is about another
 * cluster, "not found" or somebody else's object.
 */
export function cliLine(
  tool: "kubectl" | "helm",
  at: CliTarget,
  args: string,
  shell: Shell = hostShell()
): string {
  return cliPipe(at, [[tool, args]], shell);
}

/**
 * Commands piped one into the next, each acting on `at`. A POSIX shell
 * takes `KUBECONFIG=` before each command, for that command alone.
 * PowerShell has no such form: the files are set once around the whole
 * pipe and what was there put back, since a stage setting them for itself
 * races the other stages over the one environment they share.
 */
export function cliPipe(
  at: CliTarget,
  steps: readonly Step[],
  shell: Shell = hostShell()
): string {
  const files = at.files ?? "FILES";
  const context = at.context ?? "CONTEXT";
  if (shell === "posix")
    return steps
      .map((step) => `KUBECONFIG=${word(files)} ${run(step, word(context))}`)
      .join(" | ");
  const pipe = steps.map((step) => run(step, psWord(context))).join(" | ");
  return `& { $was = $env:KUBECONFIG; $env:KUBECONFIG = ${psWord(files)}; try { ${pipe} } finally { $env:KUBECONFIG = $was } }`;
}

/** The cluster on screen and the files it was read from, for {@link cliLine}. */
export function useCliTarget(): CliTarget {
  const context = useClusterStore((s) => s.currentContext);
  const files = useQuery({
    queryKey: queryKeys.cliKubeconfig(context),
    queryFn: () => commands.cliKubeconfig(context!),
    enabled: context !== null,
    staleTime: Infinity,
  });
  // After a failed ask the last answer is held still, and may name files
  // the app no longer reads the context from: no files, and why.
  const read = files.isError ? null : (files.data ?? null);
  const why = files.isError ? errorToShow(files.error) : null;
  const { refetch } = files;
  return useMemo(
    () => ({ context, files: read, why, retry: () => void refetch() }),
    [context, read, why, refetch]
  );
}

/** Groups kubectl resolves by the bare kind; anything else could be two CRDs. */
const BUILT_IN_GROUPS = new Set([
  "",
  "apps",
  "batch",
  "policy",
  "autoscaling",
  "networking.k8s.io",
  "storage.k8s.io",
  "discovery.k8s.io",
  "apiextensions.k8s.io",
]);

/**
 * The command that reads this object from a terminal. A Gateway API kind is
 * spelled with its group, because Istio ships a `gateways` of its own and the
 * bare word answers with whichever kubectl finds first.
 */
export function kubectlGet(
  object: {
    kind: string;
    name: string;
    namespace?: string | null;
  },
  at: CliTarget
): string | null {
  const facts = kindFacts(object.kind);
  if (!facts) return null;
  const resource = BUILT_IN_GROUPS.has(facts.group)
    ? facts.kind.toLowerCase()
    : `${facts.plural}.${facts.group}`;
  const where = object.namespace ? ` -n ${word(object.namespace)}` : "";
  return cliLine("kubectl", at, `get ${resource} ${word(object.name)}${where}`);
}
