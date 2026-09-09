import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { useHintChain } from "@/components/pod/useHintChain";
import { commands } from "@/lib/commands";
import { buildDeepLink } from "@/lib/deep-link";
import { familyOf } from "@/lib/event-stories";
import { hintFor, troubleOf } from "@/lib/hints";
import type {
  Report,
  ReportChange,
  ReportFact,
  ReportHop,
  ReportWords,
} from "@/lib/report";
import { describeTermination, lastTermination } from "@/lib/pod-status";
import { useChangeJournalStore } from "@/stores/changeJournalStore";
import { useClusterStore } from "@/stores/clusterStore";
import { useT, type T } from "@/i18n/useT";
import type {
  EventInfo,
  PodInfo,
  ResourceConnections,
} from "@/generated/types";

/** As many journal entries as a reader scrolls; older ones are in the app. */
const MAX_CHANGES = 20;

function words(t: T): ReportWords {
  return {
    title: t("share", "reportTitle"),
    captured: t("share", "captured"),
    openInRubick: t("share", "openInRubick"),
    linkFallback: t("share", "linkFallback"),
    verdict: t("share", "sectionVerdict"),
    facts: t("share", "sectionFacts"),
    chain: t("share", "sectionChain"),
    changes: t("share", "sectionChanges"),
    logs: t("share", "sectionLogs"),
    notRead: t("share", "sectionNotRead"),
    nothingHere: t("share", "nothingHere"),
    previousRun: t("share", "previousRun"),
    notLookedAt: t("share", "notLookedAt"),
    madeBy: t("share", "madeBy"),
    noSecrets: t("share", "noSecrets"),
  };
}

function factsOf(pod: PodInfo, t: T): ReportFact[] {
  const facts: ReportFact[] = [
    {
      label: t("columns", "status"),
      value: pod.status.display,
      tone: pod.status.ready ? undefined : "warn",
    },
  ];
  if (pod.nodeName)
    facts.push({ label: t("columns", "node"), value: pod.nodeName });
  if (pod.podIp) facts.push({ label: t("columns", "podIp"), value: pod.podIp });
  for (const container of [...pod.initContainers, ...pod.containers]) {
    const exit = lastTermination(container);
    const state =
      container.state.type === "waiting"
        ? (container.state.reason ?? "waiting")
        : container.state.type;
    facts.push({
      label: container.name,
      value: [
        container.image,
        state,
        container.restartCount > 0
          ? t("count", "restartsSoFar", { n: container.restartCount })
          : null,
        exit ? describeTermination(exit) : null,
      ]
        .filter(Boolean)
        .join(" · "),
      tone: exit && exit.exitCode !== 0 ? "err" : undefined,
    });
  }
  return facts;
}

function ref(object: { kind: string; name: string; namespace: string | null }) {
  return `${object.kind} ${object.namespace ? `${object.namespace}/` : ""}${object.name}`;
}

/**
 * The chain as the graph drew it, hop by hop, with `notChecked` carried
 * rather than flattened: a report that shows an unread hop as an ordinary
 * one is the same lie on paper that the app refuses to tell on screen.
 */
function chainOf(
  connections: ResourceConnections | undefined,
  t: T
): ReportHop[] {
  if (!connections) return [];
  return connections.edges.map((edge) => ({
    from: ref(edge.from),
    to: ref(edge.to),
    relation: edge.relation.verb,
    known:
      edge.from.existence !== "notChecked" &&
      edge.to.existence !== "notChecked",
    note: edge.to.existence === "missing" ? t("share", "hopMissing") : null,
  }));
}

function changesOf(
  entries: ReturnType<typeof useChangeJournalStore.getState>["entries"],
  context: string,
  pod: PodInfo,
  t: T
): ReportChange[] {
  const family = familyOf(pod.name);
  const mine: ReportChange[] = entries
    .filter(
      (entry) =>
        entry.context === context &&
        entry.namespace === pod.namespace &&
        (entry.name === family || family.startsWith(`${entry.name}-`))
    )
    .slice(-MAX_CHANGES)
    .reverse()
    .map((entry): ReportChange => ({
      at: new Date(entry.at).toISOString(),
      text: [
        `${entry.kind} ${entry.name}`,
        entry.field,
        entry.key ?? null,
        entry.from !== null || entry.to !== null
          ? `${entry.from ?? "∅"} → ${entry.to ?? "∅"}`
          : null,
      ]
        .filter(Boolean)
        .join(" · "),
    }));
  // A journal with nothing in it about this pod is two different facts: the
  // app was watching and the pod held still, or the app was never watching
  // at all. The second one is said, so a reader does not take silence for calm.
  if (mine.length === 0 && entries.length === 0) {
    return [{ at: null, text: t("share", "journalEmpty") }];
  }
  return mine;
}

export interface PodReport {
  report: Report | null;
  isPending: boolean;
}

/**
 * Everything the report needs, from what the page already read: the pod,
 * its events, the connections graph, the chain behind its trouble, and the
 * journal this app kept while it was connected.
 */
export function usePodReport(
  pod: PodInfo | undefined,
  events: EventInfo[],
  eventsError: string | null,
  connections: ResourceConnections | undefined,
  path: string
): PodReport {
  const t = useT();
  const context = useClusterStore((s) => s.currentContext) ?? "";
  const trouble = useMemo(
    () => (pod ? troubleOf(pod, events) : null),
    [pod, events]
  );
  const { chain, logLines, logContainer, previous } = useHintChain(
    pod ?? EMPTY_POD,
    trouble,
    pod !== undefined
  );
  const version = useQuery({
    queryKey: ["app-info"],
    queryFn: () => commands.getAppInfo(),
    staleTime: Infinity,
  });
  const journal = useChangeJournalStore((s) => s.entries);

  const report = useMemo<Report | null>(() => {
    if (!pod) return null;
    const notRead = [...chain.notRead];
    if (eventsError)
      notRead.push(t("hints", "notReadEvents", { reason: eventsError }));
    for (const unread of connections?.notLookedAt ?? []) {
      notRead.push(t("share", "kindNotLookedAt", { kind: unread.kind }));
    }
    return {
      subject: {
        kind: "Pod",
        name: pod.name,
        namespace: pod.namespace,
        context,
      },
      capturedAt: new Date().toISOString(),
      appVersion: version.data?.version ?? "",
      verdict: trouble ? sayHint(trouble, pod, chain, t) : null,
      facts: factsOf(pod, t),
      chain: chainOf(connections, t),
      changes: changesOf(journal, context, pod, t),
      logs: logContainer
        ? [
            {
              source: `${pod.name}/${logContainer}`,
              lines: logLines,
              previous,
            },
          ]
        : [],
      notRead,
      link: buildDeepLink(context, path),
      words: words(t),
    };
  }, [
    pod,
    trouble,
    chain,
    connections,
    context,
    eventsError,
    journal,
    logContainer,
    logLines,
    previous,
    version.data,
    path,
    t,
  ]);

  return { report, isPending: version.isPending };
}

function sayHint(
  trouble: NonNullable<ReturnType<typeof troubleOf>>,
  pod: PodInfo,
  chain: Parameters<typeof hintFor>[2],
  t: T
): string {
  const hint = hintFor(trouble, pod, chain);
  return t("hints", hint.headline.key, hint.headline.values ?? {});
}

/** The hook needs a pod to key its reads on; nothing is fetched for this one. */
const EMPTY_POD = {
  name: "",
  namespace: "",
  containers: [],
  initContainers: [],
  restartCount: 0,
} as unknown as PodInfo;
