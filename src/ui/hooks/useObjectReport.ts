import { useMemo } from "react";

import type {
  ShareContribution,
  ShareFrame,
} from "@/components/share/contribution";
import { useAppInfo } from "@/hooks/useAppInfo";
import { useConnections } from "@/hooks/useConnections";
import { useObjectEvents } from "@/hooks/useObjectEvents";
import { useIngressRouting } from "@/hooks/useIngressRouting";
import { useLocationHref } from "@/hooks/useLocationHref";
import { useSilentNodes } from "@/hooks/useSilentNodes";
import { useCapabilities } from "@/integrations";
import { useT } from "@/i18n/useT";
import { buildDeepLink } from "@/lib/deep-link";
import { errorToShow } from "@/lib/error-utils";
import { iconSvg } from "@/lib/icon-svg";
import type { Report } from "@/lib/report";
import {
  CONNECTED_KINDS,
  ORDER,
  TRAFFIC_KINDS,
  changesSection,
  conditionsSection,
  eventsSection,
  frameIcons,
  frameWords,
  kindIcon,
  placed,
  refOf,
  unreadLines,
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

/** Who owns the object, wherever its shape keeps `ownerReferences`. */
function ownersIn(resource: unknown): { kind: string; name: string }[] {
  const object = resource as {
    ownerReferences?: unknown;
    metadata?: { ownerReferences?: unknown };
  } | null;
  const refs = object?.ownerReferences ?? object?.metadata?.ownerReferences;
  return Array.isArray(refs)
    ? refs.filter(
        (ref): ref is { kind: string; name: string } =>
          typeof ref?.kind === "string" && typeof ref?.name === "string"
      )
    : [];
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
  contribute: ((frame: ShareFrame) => ShareContribution) | undefined,
  capturing: boolean
): { report: Report | null; isPending: boolean } {
  const t = useT();
  const locale = useLocale();
  const context = useClusterStore((s) => s.currentContext) ?? "";
  const journal = useChangeJournalStore((s) => s.entries);
  const spans = useChangeJournalStore((s) => s.spans);
  const colouring = useDisplaySettingsStore((s) => s.resourceColouring);
  const version = useAppInfo();
  const vendors = useCapabilities("object.report");
  const href = useLocationHref();
  const graphed = !!subject && CONNECTED_KINDS.has(subject.kind);
  const silent = useSilentNodes(capturing);

  const connections = useConnections(
    subject?.kind ?? "",
    subject?.name,
    subject?.namespace,
    capturing && graphed
  );
  // The certificates and controllers in front of the object, as the page's
  // chain reads them; nothing until Share is pressed, like the graph itself.
  const routed = useIngressRouting(capturing ? connections.data : undefined);
  const events = useObjectEvents(
    subject?.kind ?? "",
    subject?.name,
    subject?.namespace,
    { enabled: capturing && !!subject, refresh: "slow" }
  );

  const capturedAt = useMemo(() => {
    void subject?.name;
    void capturing;
    return new Date().toISOString();
  }, [subject?.name, capturing]);

  const report = useMemo<Report | null>(() => {
    if (!subject || !capturing || version.data === undefined) return null;
    const own = contribute?.({ silent, capturedAt }) ?? {};

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
        events.error
          ? errorToShow(events.error)
          : events.isPending && !events.data
            ? t("share", "stillReading")
            : null
      )
    );
    const changes = changesSection(
      { entries: journal, spans: spans[context] ?? [] },
      context,
      { ...subject, owners: ownersIn(resource) },
      capturedAt,
      t
    );
    if (changes) sections.push(changes);
    const notLookedAt: string[] = [];
    if (graphed) {
      const graph = graphSections(
        connections,
        t,
        TRAFFIC_KINDS.has(subject.kind),
        {
          certificates: own.chain?.certificates ?? routed.certificates,
          controller: own.chain?.controller,
          routing: routed.routing,
        }
      );
      sections.push(...graph.sections);
      for (const unread of connections.data?.notLookedAt ?? [])
        notLookedAt.push(t("share", "kindNotLookedAt", { kind: unread.kind }));
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
    // Everything a section says it could not read, said again where the
    // reader looks for it; a page's own words about the rest come first.
    const notRead = [
      ...new Set([
        ...(own.notRead ?? []),
        ...unreadLines(sections),
        ...notLookedAt,
      ]),
    ];

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
      link: buildDeepLink(href, new Date(capturedAt)),
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
    spans,
    silent,
    context,
    graphed,
    connections,
    routed.certificates,
    routed.routing,
    vendors,
    capturedAt,
    colouring,
    locale,
    href,
  ]);

  return { report, isPending: version.isPending };
}
