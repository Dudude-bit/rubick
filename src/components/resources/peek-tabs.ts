import { toKind } from "@/lib/resource-registry";

/**
 * Which work surfaces a peeked object actually has.
 *
 * One fixed tab strip across every kind would lie: a ConfigMap has no logs
 * and a Service has no containers, and a tab that opens onto "nothing here"
 * is worse than no tab. The middle of the strip is therefore per kind; only
 * Overview and YAML are universal, because every kind answers both.
 *
 * Events deliberately stay inside Overview rather than becoming a tab. They
 * are the answer to "why is this red", which is the question a peek is opened
 * to ask — putting them one click away hides the thing being looked for.
 */
export type PeekTabId =
  | "overview"
  | "logs"
  | "containers"
  | "data"
  | "children"
  | "yaml";

export interface PeekTabDefinition {
  id: PeekTabId;
  label: string;
}

const OVERVIEW: PeekTabDefinition = { id: "overview", label: "Overview" };
const YAML: PeekTabDefinition = { id: "yaml", label: "YAML" };

/** The kinds whose children are worth listing, and what those children are. */
const CHILDREN_LABEL = {
  Deployment: "Pods",
  StatefulSet: "Pods",
  DaemonSet: "Pods",
  Job: "Pods",
  // A CronJob owns Jobs, not Pods — its pods are two hops away and belong to
  // whichever run produced them. Listing the runs is the honest answer.
  CronJob: "Jobs",
} as const;

export function peekTabsFor(kind: string): PeekTabDefinition[] {
  const resolved = toKind(kind);
  const middle: PeekTabDefinition[] = [];

  if (resolved === "Pod") {
    middle.push(
      { id: "logs", label: "Logs" },
      { id: "containers", label: "Containers" }
    );
  } else if (resolved === "ConfigMap" || resolved === "Secret") {
    middle.push({ id: "data", label: "Data" });
  } else if (resolved && resolved in CHILDREN_LABEL) {
    middle.push({
      id: "children",
      label: CHILDREN_LABEL[resolved as keyof typeof CHILDREN_LABEL],
    });
  }

  return [OVERVIEW, ...middle, YAML];
}

/**
 * The tab to show for a target, given the one the reader last asked for.
 *
 * Staying on Logs while clicking down a list of pods is the whole point of a
 * peek, so the request survives a change of target. It is only a request: a
 * kind that has no such tab falls back to Overview without forgetting it, so
 * the next pod opens on Logs again.
 */
export function resolvePeekTab(
  requested: PeekTabId,
  tabs: PeekTabDefinition[]
): PeekTabId {
  return tabs.some((tab) => tab.id === requested) ? requested : "overview";
}
