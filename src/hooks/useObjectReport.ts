import { useMemo } from "react";
import { useLocation } from "react-router-dom";

import type { ShareContribution } from "@/components/share/contribution";
import { useAppInfo } from "@/hooks/useAppInfo";
import { useConnections } from "@/hooks/useConnections";
import { useLiveQuery } from "@/hooks/useLiveQuery";
import { useCapabilities } from "@/integrations";
import { useT } from "@/i18n/useT";
import { commands } from "@/lib/commands";
import { buildDeepLink } from "@/lib/deep-link";
import { errorToShow } from "@/lib/error-utils";
import { iconSvg } from "@/lib/icon-svg";
import { queryKeys } from "@/lib/query-keys";
import type { Report } from "@/lib/report";
import {
  CONNECTED_KINDS,
  ORDER,
  changesSection,
  conditionsSection,
  eventsSection,
  frameIcons,
  frameWords,
  kindIcon,
  placed,
  refOf,
  type PlacedSection,
} from "@/lib/report-parts";
import { graphSections } from "@/lib/report-graph";
import { kindHue } from "@/lib/resource-identity";
import { useChangeJournalStore } from "@/stores/changeJournalStore";
import { useClusterStore } from "@/stores/clusterStore";
import { useDisplaySettingsStore } from "@/stores/displaySettingsStore";
import { useLocale } from "@/stores/localeStore";
import type { ConditionInfo } from "@/generated/types";
import { Server } from "lucide-react";

export interface ObjectSubject {
  kind: string;
  name: string;
  namespace: string | null;
}

/** `conditions` wherever the object keeps them, in the shape every core kind uses. */
function conditionsIn(resource: unknown): ConditionInfo[] | null {
  const candidates = [
    (resource as { conditions?: unknown })?.conditions,
    (resource as { status?: { conditions?: unknown } })?.status?.conditions,
  ];
  for (const candidate of candidates) {
    if (
      Array.isArray(candidate) &&
      candidate.every(
        (entry) =>
          typeof entry?.type === "string" && typeof entry?.status === "string"
      )
    )
      return candidate as ConditionInfo[];
  }
  return null;
}

function groupOf(resource: unknown): string {
  const apiVersion = (resource as { apiVersion?: unknown })?.apiVersion;
  return typeof apiVersion === "string" && apiVersion.includes("/")
    ? apiVersion.split("/")[0]
    : "";
}

/**
 * The report of one object, from what every object has plus what its page
 * contributes. Nothing is read until `capturing`: the frame is on every
 * detail page, and a Share nobody pressed must cost nothing.
 */
export function useObjectReport(
  subject: ObjectSubject | null,
  resource: unknown,
  contribute: (() => ShareContribution) | undefined,
  capturing: boolean
): { report: Report | null; isPending: boolean } {
  const t = useT();
  const locale = useLocale();
  const context = useClusterStore((s) => s.currentContext) ?? "";
  const journal = useChangeJournalStore((s) => s.entries);
  const colouring = useDisplaySettingsStore((s) => s.resourceColouring);
  const version = useAppInfo();
  const vendors = useCapabilities("object.report");
  const location = useLocation();
  const graphed = !!subject && CONNECTED_KINDS.has(subject.kind);

  const connections = useConnections(
    subject?.kind ?? "",
    subject?.name,
    subject?.namespace,
    capturing && graphed
  );
  const events = useLiveQuery({
    queryKey: [
      ...queryKeys.events(subject?.namespace ?? null),
      "object",
      subject?.kind ?? "",
      subject?.name ?? "",
    ],
    queryFn: () =>
      commands.listEvents({
        namespace: subject?.namespace ?? null,
        involved_object_name: subject?.name ?? null,
        involved_object_kind: subject?.kind ?? null,
        event_type: null,
        field_selector: null,
        limit: 200,
      }),
    enabled: capturing && !!subject,
    refresh: "slow",
    retry: false,
  });

  const capturedAt = useMemo(() => {
    void subject?.name;
    void capturing;
    return new Date().toISOString();
  }, [subject?.name, capturing]);

  const report = useMemo<Report | null>(() => {
    if (!subject || !capturing || version.data === undefined) return null;
    const own = contribute?.() ?? {};
    const notRead = [...(own.notRead ?? [])];
    const eventsUnread = events.error
      ? t("hints", "notReadEvents", { reason: errorToShow(events.error) })
      : null;
    if (eventsUnread) notRead.push(eventsUnread);

    const sections: PlacedSection[] = [...(own.sections ?? [])];
    const found = conditionsIn(resource);
    const conditions =
      own.conditions !== undefined
        ? own.conditions
        : found && found.length > 0
          ? conditionsSection(found, t)
          : null;
    if (conditions) sections.push(conditions);
    sections.push(
      eventsSection(
        events.data,
        eventsUnread ??
          (events.isPending && !events.data ? t("share", "stillReading") : null)
      )
    );
    sections.push(changesSection(journal, context, subject, t));
    if (graphed) {
      const graph = graphSections(connections, t);
      sections.push(...graph.sections);
      if (graph.unread) notRead.push(graph.unread);
      for (const unread of connections.data?.notLookedAt ?? [])
        notRead.push(t("share", "kindNotLookedAt", { kind: unread.kind }));
    }
    const spec = (resource as { spec?: unknown })?.spec;
    const status = (resource as { status?: unknown })?.status;
    for (const vendor of vendors) {
      const theirs = vendor(
        {
          group: groupOf(resource),
          kind: subject.kind,
          namespace: subject.namespace,
          name: subject.name,
          spec,
          status,
        },
        t
      );
      for (const section of theirs ?? [])
        sections.push({ ...section, order: ORDER.vendor });
    }

    const ref = refOf(subject);
    return {
      subject: { ...subject, context },
      hero: {
        ref,
        title: subject.name,
        icon: iconSvg(kindIcon(subject.kind)),
        hue: kindHue(subject.kind),
      },
      kicker: t("share", "kicker"),
      capturedAt,
      appVersion: version.data.version,
      colouring,
      status: own.status ?? null,
      chips: [
        ...(subject.namespace
          ? [{ icon: iconSvg(kindIcon("Namespace")), text: subject.namespace }]
          : []),
        { icon: iconSvg(Server), text: context },
      ],
      stats: own.stats ?? [],
      verdict: own.verdict ?? null,
      sections: placed(sections),
      notRead,
      link: buildDeepLink(context, `${location.pathname}${location.search}`),
      words: frameWords(t, locale, notRead.length),
      icons: frameIcons(),
    };
  }, [
    subject,
    capturing,
    version.data,
    contribute,
    events.data,
    events.error,
    events.isPending,
    t,
    resource,
    journal,
    context,
    graphed,
    connections,
    vendors,
    capturedAt,
    colouring,
    locale,
    location.pathname,
    location.search,
  ]);

  return { report, isPending: version.isPending };
}
