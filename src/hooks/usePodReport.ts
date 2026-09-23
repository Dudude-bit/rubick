import { useMemo } from "react";

import { useHintChain } from "@/components/pod/useHintChain";
import { useAppInfo } from "@/hooks/useAppInfo";
import { buildDeepLink } from "@/lib/deep-link";
import { familyOf } from "@/lib/event-stories";
import { describeStop } from "@/lib/connections";
import { hintFor, sayingWords, troubleOf } from "@/lib/hints";
import { silenceNote, silenceOf, type NodeSilence } from "@/lib/node-reporting";
import { statusRole } from "@/lib/status-role";
import { useSilentNodes } from "@/hooks/useSilentNodes";
import type { ChainStop } from "@/generated/types";
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
import { useHintSettingsStore } from "@/stores/hintSettingsStore";
import { useLocale } from "@/stores/localeStore";
import type {
  EventInfo,
  PodInfo,
  ResourceConnections,
} from "@/generated/types";

/** As many journal entries as a reader scrolls; older ones are in the app. */
const MAX_CHANGES = 20;

function words(t: T, lang: string): ReportWords {
  return {
    lang,
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

function factsOf(
  pod: PodInfo,
  silence: NodeSilence | null,
  t: T
): ReportFact[] {
  // The same table the badge on the page reads. `ready` is not the status:
  // a CrashLoopBackOff and a pod still pulling its image are both "not
  // ready", and the file drew them the same amber.
  const role = statusRole(pod.status.display);
  const facts: ReportFact[] = [
    {
      label: t("columns", "status"),
      // What the kubelet last wrote is not what is true now: when the node
      // has stopped answering, the page says so beside the status and the
      // file said nothing, so a colleague read a stale state as the state.
      value: silence
        ? `${pod.status.display} · ${silenceNote(silence, t)}`
        : pod.status.display,
      tone: silence
        ? "warn"
        : role === "err"
          ? "err"
          : role === "ok"
            ? undefined
            : "warn",
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
  // Where the path stops, said in the app's own words. The file listed the
  // edges and nothing else, so a Service that publishes no endpoint — the
  // sharpest thing the graph knows — arrived as an ordinary working hop and
  // the colleague read the chain as healthy.
  const stops: ReportHop[] = connections.stops.map((stop) => {
    const said = describeStop(stop, t);
    return {
      from: ref(stopSubject(stop)),
      to: said.title,
      relation: t("share", "stopHere"),
      known: true,
      note: said.note,
    };
  });
  const hops: ReportHop[] = connections.edges.map((edge) => ({
    from: ref(edge.from),
    to: ref(edge.to),
    relation: edge.relation.verb,
    known:
      edge.from.existence !== "notChecked" &&
      edge.to.existence !== "notChecked",
    note: edge.to.existence === "missing" ? t("share", "hopMissing") : null,
  }));
  return [...hops, ...stops];
}

/**
 * The object a stop is about, per reason rather than by guessing at field
 * names.
 *
 * The Gateway API stops carry a `route` and a `gateway` and neither of the
 * names the guess looked for, so a report of a route that was never accepted
 * named an object with no kind and no name — an empty row where the reason
 * the chain stops belongs.
 */
function stopSubject(stop: ChainStop): {
  kind: string;
  name: string;
  namespace: string | null;
} {
  switch (stop.reason) {
    case "backendMissing":
      return stop.service;
    case "routeNotAccepted":
    case "routeRefsUnresolved":
      return stop.route;
    case "gatewayMissing":
      return stop.gateway;
    case "selectsNothing":
    case "publishesNothingYet":
    case "noneReady":
    case "publishesNothing":
      return stop.service;
  }
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
  // Scoped to this cluster: the journal is global, so a session spent
  // watching another cluster made `entries.length` non-zero and the hedge
  // disappeared — "What changed: Nothing here." about a cluster this app
  // never watched.
  if (
    mine.length === 0 &&
    !entries.some((entry) => entry.context === context)
  ) {
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
  /**
   * The whole read, not its answer. A refused or still-running read hands
   * back `undefined`, which the file used to print as "Nothing here." under
   * the chain — the opposite answer, on the one page whose screen says in
   * that state that it could not read what connects.
   */
  connections: {
    data: ResourceConnections | undefined;
    error: unknown;
    isPending: boolean;
  },
  path: string
): PodReport {
  const t = useT();
  const locale = useLocale();
  const context = useClusterStore((s) => s.currentContext) ?? "";
  const trouble = useMemo(
    () => (pod ? troubleOf(pod, events) : null),
    [pod, events]
  );
  // The same two settings the panel reads. The report used to ask for logs
  // on every pod page whatever they said, so turning «Most likely» off
  // stopped the panel and not the reading behind it.
  const showPanel = useHintSettingsStore((state) => state.showPanel);
  const includeLogLines = useHintSettingsStore(
    (state) => state.includeLogLines
  );
  const { chain, logLines, logContainer, previous } = useHintChain(
    pod ?? EMPTY_POD,
    trouble,
    pod !== undefined && showPanel
  );
  const version = useAppInfo();
  const journal = useChangeJournalStore((s) => s.entries);
  // The same fact the page reads beside the status badge: when the node has
  // stopped answering, everything the kubelet wrote is the last thing it
  // said and not the state now.
  const silence = silenceOf(pod?.nodeName, useSilentNodes(pod !== undefined));

  // When the reader pressed Share, not when React last re-rendered. The
  // stamp was taken inside the memo, so every watch tick and every log poll
  // minted a new one — which is also the identity the dialog keys the
  // public-target acknowledgement and the published link on, so both erased
  // themselves a second later.
  const subjectKey = pod ? `${context}/${pod.namespace}/${pod.name}` : "";
  const capturedAt = useMemo(() => {
    // The subject is read so the dependency is a real one: the stamp is
    // minted per object, and a watch tick on the same pod keeps it.
    void subjectKey;
    return new Date().toISOString();
  }, [subjectKey]);

  const report = useMemo<Report | null>(() => {
    if (!pod) return null;
    // Without the version the file's footer says it was made by an app with
    // no name for itself, and the reader has no way back to the build that
    // wrote it. It is one local call; the report waits for it.
    if (version.data === undefined) return null;
    const notRead = [...chain.notRead];
    if (eventsError)
      notRead.push(t("hints", "notReadEvents", { reason: eventsError }));
    for (const unread of connections.data?.notLookedAt ?? []) {
      notRead.push(t("share", "kindNotLookedAt", { kind: unread.kind }));
    }
    // The same sentence the page shows in this state, in the file and in
    // "Not read" both, rather than an empty chain that reads as "nothing is
    // wired to this pod".
    const chainUnread =
      connections.error !== null && connections.error !== undefined
        ? t("empty", "couldNotReadWhatConnects")
        : connections.isPending || connections.data === undefined
          ? t("share", "chainStillReading")
          : null;
    if (chainUnread) notRead.push(chainUnread);
    return {
      subject: {
        kind: "Pod",
        name: pod.name,
        namespace: pod.namespace,
        context,
      },
      capturedAt,
      appVersion: version.data.version,
      verdict: trouble ? sayHint(trouble, pod, chain, t) : null,
      facts: factsOf(pod, silence, t),
      chain: chainOf(connections.data, t),
      chainUnread,
      changes: changesOf(journal, context, pod, t),
      // A source with no lines under it is a heading over nothing: the
      // reader turned the lines off, or the app never read them.
      logs:
        logContainer && includeLogLines && logLines.length > 0
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
      words: words(t, locale),
    };
  }, [
    pod,
    capturedAt,
    trouble,
    chain,
    connections,
    context,
    eventsError,
    journal,
    locale,
    silence,
    logContainer,
    logLines,
    includeLogLines,
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
  // The same resolution the panel does: a value may itself be a saying.
  return sayingWords(hint.headline, t);
}

/** The hook needs a pod to key its reads on; nothing is fetched for this one. */
const EMPTY_POD = {
  name: "",
  namespace: "",
  containers: [],
  initContainers: [],
  restartCount: 0,
} as unknown as PodInfo;
