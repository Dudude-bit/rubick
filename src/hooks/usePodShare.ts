import { useCallback, useMemo } from "react";
import { Container } from "lucide-react";

import type { ShareContribution } from "@/components/share/contribution";
import { readLogView, logViewKey } from "@/components/logs/shared-view";
import { logsToText } from "@/components/logs/types";
import { useHintChain } from "@/components/pod/useHintChain";
import { hintFor, sayingWords, troubleOf } from "@/lib/hints";
import { iconSvg } from "@/lib/icon-svg";
import { parseImageRef } from "@/lib/image-ref";
import { silenceNote, silenceOf, type NodeSilence } from "@/lib/node-reporting";
import type { ReportContainer, ReportLog, ReportStat } from "@/lib/report";
import {
  ORDER,
  logsSectionShell,
  refOf,
  type PlacedSection,
} from "@/lib/report-parts";
import { statusRole, type StatusRole } from "@/lib/status-role";
import { formatSince } from "@/lib/utils";
import { describeTermination, lastTermination } from "@/lib/pod-status";
import { useSilentNodes } from "@/hooks/useSilentNodes";
import { useT, type T } from "@/i18n/useT";
import { useHintSettingsStore } from "@/stores/hintSettingsStore";
import type { ContainerInfo, EventInfo, PodInfo } from "@/generated/types";

/** A published page, not a log store: the tail is what a colleague reads. */
const MAX_LOG_LINES = 500;

function statusOf(pod: PodInfo, silence: NodeSilence | null, t: T) {
  return {
    text: silence
      ? `${pod.status.display} · ${silenceNote(silence, t)}`
      : pod.status.display,
    role: silence ? ("warn" as const) : statusRole(pod.status.display),
  };
}

function statsOf(pod: PodInfo, capturedAt: string, t: T): ReportStat[] {
  const ready = pod.containers.filter((container) => container.ready).length;
  const stats: ReportStat[] = [
    {
      label: t("columns", "ready"),
      value: `${ready}/${pod.containers.length}`,
      role: ready === pod.containers.length ? "ok" : "warn",
    },
    {
      label: t("columns", "restarts"),
      value: String(pod.restartCount),
      role: pod.restartCount > 0 ? "warn" : undefined,
    },
  ];
  const created = pod.createdAt ? Date.parse(pod.createdAt) : NaN;
  if (!Number.isNaN(created))
    stats.push({
      label: t("columns", "age"),
      value: formatSince(created, Date.parse(capturedAt)),
      note: t("share", "atCapture"),
    });
  if (pod.nodeName)
    stats.push({
      label: t("columns", "node"),
      value: pod.nodeName,
      ref: refOf({ kind: "Node", name: pod.nodeName, namespace: null }),
    });
  if (pod.podIp) stats.push({ label: t("columns", "podIp"), value: pod.podIp });
  return stats;
}

function stateOf(container: ContainerInfo): string {
  switch (container.state.type) {
    case "running":
      return "Running";
    case "waiting":
      return container.state.reason ?? "Waiting";
    case "terminated":
      return container.state.termination.reason ?? "Terminated";
    case "unknown":
      return "Unknown";
  }
}

function containersOf(pod: PodInfo, t: T): ReportContainer[] {
  const row = (container: ContainerInfo, init: boolean): ReportContainer => {
    const image = parseImageRef(container.image);
    const exit = lastTermination(container);
    const state = stateOf(container);
    const role: StatusRole =
      exit && exit.exitCode !== 0 && state !== "Running"
        ? "err"
        : statusRole(state);
    return {
      name: container.name,
      repository: image
        ? [image.registry, image.repository].filter(Boolean).join("/")
        : container.image,
      tag: image ? (image.tag ?? image.digest?.slice(0, 19) ?? null) : null,
      state,
      role,
      notes: [
        container.restartCount > 0
          ? t("count", "restartsSoFar", { n: container.restartCount })
          : null,
        exit ? describeTermination(exit) : null,
      ].filter((note): note is string => note !== null),
      init,
    };
  };
  return [
    ...pod.initContainers.map((container) => row(container, true)),
    ...pod.containers.map((container) => row(container, false)),
  ];
}

/**
 * What the Logs tab is showing, filters and all, when it was opened on this
 * page; otherwise the lines the "Most likely" panel read for its verdict.
 */
function logsOf(
  pod: PodInfo,
  hint: { container: string | null; lines: string[]; previous: boolean },
  t: T
): { logs: ReportLog[]; absent: string | null } {
  const viewed = readLogView(logViewKey(pod.namespace, pod.name));
  if (viewed && viewed.lines.length > 0) {
    const tail = viewed.lines.slice(-MAX_LOG_LINES);
    const containers = [...new Set(tail.map((line) => line.container))];
    const several = containers.length > 1;
    return {
      logs: [
        {
          source: several ? pod.name : `${pod.name}/${containers[0]}`,
          lines: tail.map((line) => ({
            text: `${several ? `[${line.container}] ` : ""}${logsToText([line])}`,
            level: line.level,
          })),
          previous: viewed.previous,
          caption:
            tail.length < viewed.lines.length
              ? t("share", "logsTail", {
                  n: tail.length,
                  total: viewed.lines.length,
                })
              : t("share", "logsShown", { n: tail.length }),
        },
      ],
      absent: null,
    };
  }
  if (hint.container && hint.lines.length > 0) {
    return {
      logs: [
        {
          source: `${pod.name}/${hint.container}`,
          lines: hint.lines.map((text) => ({ text, level: null })),
          previous: hint.previous,
          caption: t("share", "logsFromHint"),
        },
      ],
      absent: null,
    };
  }
  return { logs: [], absent: t("share", "logsNotOpened") };
}

function containersSection(pod: PodInfo, t: T): PlacedSection {
  const containers = containersOf(pod, t);
  return {
    id: "containers",
    order: ORDER.own,
    title: t("columns", "containers"),
    icon: iconSvg(Container),
    count: containers.length,
    body: { type: "containers", containers },
  };
}

/**
 * What the pod page adds to the shared report: its status, the numbers it
 * leads with, its containers, the verdict of «Most likely» and the log lines.
 * Everything else is the frame's.
 */
export function usePodShare(
  pod: PodInfo | undefined,
  events: EventInfo[]
): () => ShareContribution {
  const t = useT();
  const trouble = useMemo(
    () => (pod ? troubleOf(pod, events) : null),
    [pod, events]
  );
  // The setting the panel reads: turning «Most likely» off has to stop the
  // reading behind it too, not only the panel.
  const showPanel = useHintSettingsStore((state) => state.showPanel);
  const { chain, logLines, logContainer, previous } = useHintChain(
    pod ?? EMPTY_POD,
    trouble,
    pod !== undefined && showPanel
  );
  // What the page says beside the status badge: when the node stopped
  // answering, everything the kubelet wrote is the last thing it said.
  const silence = silenceOf(pod?.nodeName, useSilentNodes(pod !== undefined));

  return useCallback((): ShareContribution => {
    if (!pod) return {};
    const { logs, absent } = logsOf(
      pod,
      { container: logContainer, lines: logLines, previous },
      t
    );
    return {
      status: statusOf(pod, silence, t),
      stats: statsOf(pod, new Date().toISOString(), t),
      verdict: trouble ? sayHint(trouble, pod, chain, t) : null,
      notRead: [...chain.notRead],
      sections: [
        containersSection(pod, t),
        {
          ...logsSectionShell(t),
          count: logs.reduce((sum, log) => sum + log.lines.length, 0),
          body: { type: "logs", logs, absent },
        },
      ],
    };
  }, [pod, logContainer, logLines, previous, t, silence, trouble, chain]);
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
