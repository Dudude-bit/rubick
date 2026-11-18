import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { commands } from "@/lib/commands";
import { queryKeys } from "@/lib/query-keys";
import { kindFacts } from "@/lib/resource-registry";
import { useClusterStore } from "@/stores/clusterStore";

/**
 * Where a line the app hands out acts: the cluster on screen, and the
 * kubeconfig files the app read it from. `null` where that is not known;
 * the line then carries a stand-in the reader has to fill.
 */
export interface CliTarget {
  context: string | null;
  files: string | null;
}

/** A shell word as written, quoted where the shell would read it otherwise. */
export const word = (text: string) =>
  /^[\w.:/@=+-]+$/.test(text) ? text : `'${text.replaceAll("'", `'\\''`)}'`;

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
  args: string
): string {
  const files = `KUBECONFIG=${word(at.files ?? "FILES")}`;
  const context = word(at.context ?? "CONTEXT");
  return tool === "kubectl"
    ? `${files} kubectl --context ${context} ${args}`
    : `${files} helm ${args} --kube-context ${context}`;
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
  const read = files.data ?? null;
  return useMemo(() => ({ context, files: read }), [context, read]);
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
