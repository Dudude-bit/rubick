import { useScreenCaveats } from "@/components/share/screen-share";
import { useMemo } from "react";

import type {
  ShareContribution,
  ShareFrame,
} from "@/components/share/contribution";
import { useAppInfo } from "@/hooks/useAppInfo";
import { groupOf } from "@/hooks/useCrdIndex";
import { useChainAnswer } from "@/hooks/useChainAnswer";
import { useConnections } from "@/hooks/useConnections";
import { useServiceAnswer } from "@/hooks/useServiceAnswer";
import {
  aboutAnother,
  eventsKindOf,
  useObjectEvents,
} from "@/hooks/useObjectEvents";
import { useIngressRouting } from "@/hooks/useIngressRouting";
import { useDoorAsk } from "@/hooks/useDoorAsk";
import { useRouteTls } from "@/hooks/useRouteTls";
import { eventsUidIn } from "@/hooks/useReadUid";
import { useLocationHref } from "@/hooks/useLocationHref";
import { useSilentNodes } from "@/hooks/useSilentNodes";
import { useCapabilities } from "@/integrations";
import { useT } from "@/i18n/useT";
import { buildDeepLink } from "@/lib/deep-link";
import { errorToShow } from "@/lib/error-utils";
import { builtInKindOf, isBuiltInGroup } from "@/lib/links";
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
import { ResourceType } from "@/lib/resource-registry";
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
  /**
   * The segment a kind outside the registry is served at. With it a custom
   * resource named like a built-in is not reported as that built-in.
   */
  crd?: string;
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

/**
 * The built-in kinds that own the object, wherever its shape keeps
 * `ownerReferences`: an owner in another group only shares a kind's name.
 */
function ownersIn(resource: unknown): { kind: string; name: string }[] {
  const object = resource as {
    ownerReferences?: unknown;
    metadata?: { ownerReferences?: unknown };
  } | null;
  const refs = object?.ownerReferences ?? object?.metadata?.ownerReferences;
  return Array.isArray(refs)
    ? refs.filter((ref): ref is { kind: string; name: string } => {
        if (typeof ref?.kind !== "string" || typeof ref?.name !== "string")
          return false;
        const said = ref.apiVersion ?? ref.api_version;
        return (
          typeof said !== "string" || isBuiltInGroup(ref.kind, groupOf(said))
        );
      })
    : [];
}

const groupIn = (resource: unknown): string => {
  const apiVersion = (resource as { apiVersion?: unknown })?.apiVersion;
  return typeof apiVersion === "string" ? groupOf(apiVersion) : "";
};

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
  const builtIn = subject && builtInKindOf(subject);
  const graphed = !!builtIn && CONNECTED_KINDS.has(builtIn);
  const silent = useSilentNodes(capturing);

  // The chain as the page draws it: a read its watches have outrun is still
  // being read here too, not a verdict the page has already let go of.
  const isService = builtIn === ResourceType.Service;
  const serviceQuery = useConnections(
    ResourceType.Service,
    isService ? subject?.name : undefined,
    subject?.namespace,
    capturing
  );
  const service = useServiceAnswer(
    isService ? subject?.name : undefined,
    subject?.namespace,
    serviceQuery,
    false
  );
  const chain = useChainAnswer(
    builtIn ?? "",
    isService ? undefined : subject?.name,
    subject?.namespace,
    { enabled: capturing && graphed, followed: false }
  );
  const connections = isService ? service.read : chain.read;
  // The certificates and controllers in front of the object, as the page's
  // chain reads them; nothing until Share is pressed, like the graph itself.
  const routed = useIngressRouting(capturing ? connections.data : undefined);
  const tlsOf = useRouteTls(capturing ? connections.data : undefined);
  const door = useDoorAsk(capturing);
  const events = useObjectEvents(
    subject ? eventsKindOf(subject) : { custom: "", group: null },
    subject?.name,
    subject?.namespace,
    {
      enabled: capturing && !!subject,
      refresh: "slow",
      uid: eventsUidIn(builtIn ?? "", resource),
    }
  );

  // What the page's own notices say of its read: an object kept after a
  // failed re-read is old under a new capture time.
  const caveats = useScreenCaveats();
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
    const eventsOf = { kind: subject.kind, name: subject.name };
    sections.push({
      ...eventsSection(
        events.data,
        events.error
          ? errorToShow(events.error)
          : events.isPending && !events.data
            ? t("share", "stillReading")
            : null,
        events.everyObject || ((event) => aboutAnother(event, eventsOf)),
        t("columns", "events")
      ),
      partial: events.ownedUnread
        ? `${t("empty", events.ownedUnread.unread)} ${errorToShow(events.ownedUnread.error)}`
        : events.short
          ? t("empty", "eventsReadShort")
          : null,
    });
    const changes = changesSection(
      { entries: journal, spans: spans[context] ?? [] },
      context,
      {
        kind: builtIn,
        name: subject.name,
        namespace: subject.namespace,
        owners: ownersIn(resource),
      },
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
          tlsOf,
          door,
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
          group: groupIn(resource),
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
        ...(caveats?.() ?? []),
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
        icon: iconSvg(kindIcon(subject.kind, subject.crd)),
        hue: kindHue(subject.kind, subject.crd),
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
    events.ownedUnread,
    events.everyObject,
    events.short,
    t,
    resource,
    journal,
    spans,
    silent,
    context,
    builtIn,
    graphed,
    connections,
    routed.certificates,
    routed.routing,
    tlsOf,
    door,
    vendors,
    capturedAt,
    colouring,
    locale,
    href,
    caveats,
  ]);

  return { report, isPending: version.isPending };
}
