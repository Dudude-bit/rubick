/**
 * Istio's page: the same chain, with more links in it.
 *
 * Gateway → VirtualService → DestinationRule → Service → pods, drawn left to
 * right with the columns labelled, per host, and only for the host the
 * reader opened. It is deliberately the drawing Traefik's page already uses:
 * the reader is asking the same question, and a second visual language for
 * it would be decoration.
 *
 * The three findings are the reason this beats the custom-resource list. All
 * three are references by string that nothing validates — a gateway name, a
 * hostname, a subset label — and all three are accepted by the API server in
 * silence. A VirtualService bound to a Gateway that does not cover its host
 * has no status field, no event and no condition; it simply never receives a
 * request.
 */

import { useMemo, useState } from "react";
import type { ServiceStop } from "../ingress";
import { useSearchParams } from "react-router-dom";
import { DoorOpen, Network, Split, Waypoints } from "lucide-react";

import { Section, SectionHeader } from "@/components/ui/section";
import { DetailTabs } from "@/components/resources/DetailTabs";
import { ResourceRef } from "@/components/resources/ResourceRef";
import {
  countMark,
  severityMark,
  viewGlyph,
  type DetailTab,
  type DetailTabMark,
} from "@/components/resources/detail-tab";
import { describeStop } from "@/lib/connections";
import { RoutingMap } from "../routing-map";
import { routingMap } from "./map";
import type { CustomResourceInfo } from "@/generated/types";
import {
  Chain,
  Cell,
  Column,
  FilterBox,
  Finding as FindingBlock,
  TroubleRow,
  type Tone,
} from "../page-kit";
import { KINDS, sourcesFrom, useBacking, useMesh } from "./data";
import { describeMatch, fullyRead, type MatchReading } from "./match";
import {
  backingOf,
  hostGroups,
  subsetsFor,
  type Destination,
  type Finding,
  type IstioHostGroup,
  type IstioRoute,
  type IstioSources,
} from "./model";
import { useT } from "@/i18n/useT";
import type { en } from "@/i18n/catalogue";

const AUTO_OPEN = 8;

export default function IstioPage() {
  const t = useT();
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") ?? "routes";

  const mesh = useMesh();
  const backing = useBacking();

  const sources: IstioSources | null = mesh.data
    ? sourcesFrom(mesh.data, backing.data)
    : null;

  const groups = useMemo(
    () => (sources ? hostGroups(sources, t) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mesh.data, backing.data]
  );

  if (mesh.error) {
    return (
      <Section className="max-w-[64ch] py-8">
        <h2 className="text-[13px] font-semibold tracking-tight text-err">
          {t("empty", "couldNotReadMeshRouting")}
        </h2>
        <p className="text-xs text-fg-mut">
          {t("empty", "meshRoutingRequestFailed")}
        </p>
        <p className="text-[11px] text-fg-fnt">{mesh.error.message}</p>
      </Section>
    );
  }

  const troubled = groups.filter((group) => group.worst !== null);

  const tabs: DetailTab[] = [
    {
      id: "routes",
      label: t("nav", "routes"),
      glyph: viewGlyph(Waypoints),
      mark: routesMark(groups, troubled.length, t),
      content: (
        <RoutesTab
          groups={groups}
          sources={sources}
          loading={mesh.isPending}
          backingLoading={backing.isPending}
        />
      ),
    },
    {
      id: "map",
      label: t("nav", "map"),
      glyph: viewGlyph(Network),
      content: (
        <MapTab groups={groups} sources={sources} loading={mesh.isPending} />
      ),
    },
    {
      id: "gateways",
      label: "Gateways",
      glyph: viewGlyph(DoorOpen),
      mark: mesh.data ? countMark(mesh.data.gateways.length) : undefined,
      content: (
        <GatewaysTab
          gateways={mesh.data?.gateways ?? []}
          groups={groups}
          loading={mesh.isPending}
        />
      ),
    },
    {
      id: "subsets",
      label: t("nav", "subsets"),
      glyph: viewGlyph(Split),
      mark: subsetsMark(groups, t),
      content: (
        <SubsetsTab
          rules={mesh.data?.destinationRules ?? []}
          groups={groups}
          sources={sources}
          loading={mesh.isPending}
        />
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-[22px]">
      <SectionHeader
        title="Istio"
        count={
          mesh.isPending
            ? undefined
            : t("count", "hostsAcrossNamespaces", { n: groups.length })
        }
        description={t("empty", "istioPageDescription")}
      />
      <DetailTabs
        tabs={tabs}
        activeTab={tab}
        onTabChange={(next) => {
          const updated = new URLSearchParams(params);
          updated.set("tab", next);
          setParams(updated, { replace: true });
        }}
      />
    </div>
  );
}

function routesMark(
  groups: IstioHostGroup[],
  troubled: number,
  t: ReturnType<typeof useT>
): DetailTabMark | undefined {
  if (groups.length === 0) return undefined;
  const worst = groups.some((group) => group.worst === "err") ? "err" : "warn";
  return troubled > 0
    ? severityMark(
        worst,
        t("count", "hostsNeedAttention", { n: troubled, total: groups.length })
      )
    : countMark(groups.length);
}

function subsetsMark(
  groups: IstioHostGroup[],
  t: ReturnType<typeof useT>
): DetailTabMark | undefined {
  const missing = groups.flatMap((group) =>
    group.findings.filter((finding) => finding.kind === "noSubset")
  ).length;
  return missing > 0
    ? severityMark("err", t("count", "routesToUndefinedSubset", { n: missing }))
    : undefined;
}

// --- routes -------------------------------------------------------------

/**
 * The shape across hosts: which gateways carry which hostnames, and which
 * of them land on the same Service. The namespace filter and the
 * rest-on-a-node highlight live in the map itself.
 */
function MapTab({
  groups,
  sources,
  loading,
}: {
  groups: IstioHostGroup[];
  sources: IstioSources | null;
  loading: boolean;
}) {
  const t = useT();
  const data = useMemo(
    () => (sources ? routingMap(groups, sources, t) : null),
    [groups, sources, t]
  );

  if (loading) {
    return <p className="text-xs text-fg-fnt">{t("empty", "readingMesh")}</p>;
  }
  if (!data || groups.length === 0) {
    return (
      <p className="max-w-[64ch] text-xs text-fg-mut">
        {t("empty", "noVirtualServiceRoutes")}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <RoutingMap data={data} />
      <p className="text-[11px] text-fg-fnt">{t("empty", "restOnNodeHint")}</p>
    </div>
  );
}

function RoutesTab({
  groups,
  sources,
  loading,
  backingLoading,
}: {
  groups: IstioHostGroup[];
  sources: IstioSources | null;
  loading: boolean;
  backingLoading: boolean;
}) {
  const t = useT();
  const [filter, setFilter] = useState("");

  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (needle === "") return groups;
    return groups.filter(
      (group) =>
        group.host.toLowerCase().includes(needle) ||
        group.routes.some(
          (route) =>
            route.source.name.toLowerCase().includes(needle) ||
            route.destinations.some((destination) =>
              destination.host.toLowerCase().includes(needle)
            )
        )
    );
  }, [groups, filter]);

  if (loading) {
    return <p className="text-xs text-fg-fnt">{t("empty", "readingMesh")}</p>;
  }

  if (groups.length === 0) {
    return (
      <div className="max-w-[64ch]">
        <p className="text-xs text-fg-mut">
          {t("empty", "istioNothingRoutes")}
        </p>
        <p className="mt-1.5 text-[11px] text-fg-fnt">
          {t("empty", "istioNoVirtualServiceHost")}
        </p>
      </div>
    );
  }

  const broken = groups.filter((group) => group.worst === "err").length;
  const worthALook = groups.filter((group) => group.worst === "warn").length;

  return (
    <div className="flex flex-col">
      <div className="mb-1 flex items-center gap-3">
        <FilterBox
          value={filter}
          onChange={setFilter}
          placeholder={t("action", "filterByHostVirtualServiceDestination")}
          label={t("action", "filterHosts")}
        />
        <span className="text-[11px] text-fg-fnt">
          {filter.trim() !== ""
            ? t("count", "nOfTotal", { n: shown.length, total: groups.length })
            : broken > 0
              ? `${t("count", "brokenOfTotalFirst", { n: broken, total: groups.length })}${worthALook > 0 ? ` · ${t("count", "worthALook", { n: worthALook })}` : ""}`
              : worthALook > 0
                ? `${t("empty", "nothingBroken")} · ${t("count", "worthALookOfTotal", { n: worthALook, total: groups.length })}`
                : t("count", "hostsNoneWithProblem", { n: groups.length })}
        </span>
        {backingLoading && (
          <span className="text-[11px] text-fg-fnt">
            {t("empty", "checkingWhatIsBehind")}
          </span>
        )}
      </div>
      {shown.length === 0 ? (
        <p className="py-6 text-xs text-fg-fnt">
          {t("empty", "noHostVirtualServiceMatches")}
        </p>
      ) : (
        shown.map((group) => (
          <HostRow
            key={group.host}
            group={group}
            sources={sources}
            openByDefault={group.worst === "err" && broken <= AUTO_OPEN}
          />
        ))
      )}
    </div>
  );
}

function hostState(
  group: IstioHostGroup,
  t: ReturnType<typeof useT>
): { text: string; tone: Tone } {
  if (group.findings.some((finding) => finding.kind === "noGateway")) {
    return { text: t("empty", "noGatewayServesIt"), tone: "err" };
  }
  if (group.findings.some((finding) => finding.kind === "noSubset")) {
    return { text: t("empty", "subsetNotDefined"), tone: "err" };
  }
  if (group.findings.some((finding) => finding.kind === "stop")) {
    return { text: t("empty", "nothingBehindIt"), tone: "err" };
  }
  if (group.findings.some((finding) => finding.kind === "weights")) {
    return { text: t("empty", "weightsDoNotAddUp"), tone: "warn" };
  }
  if (group.findings.length > 0)
    return { text: t("empty", "worthALook"), tone: "warn" };
  return { text: t("empty", "routingState"), tone: "ok" };
}

function HostRow({
  group,
  sources,
  openByDefault,
}: {
  group: IstioHostGroup;
  sources: IstioSources | null;
  openByDefault: boolean;
}) {
  const t = useT();
  const serving = group.gateways.filter((gateway) => gateway.serves);

  return (
    <TroubleRow
      title={group.host}
      meta={
        <>
          {t("count", "rules", { n: group.routes.length })}
          {group.meshOnly
            ? ` · ${t("empty", "inMeshOnly")}`
            : serving.length > 0
              ? ` · ${t("empty", "throughGateways", { list: serving.map((gateway) => gateway.named).join(", ") })}`
              : ` · ${t("count", "gatewaysNamed", { n: group.gateways.length })}`}
        </>
      }
      state={hostState(group, t)}
      openByDefault={openByDefault}
      brief={
        group.findings.length > 0 ? <Findings group={group} brief /> : undefined
      }
    >
      <Rules group={group} sources={sources} />
      {sources && <HostChain group={group} sources={sources} />}
      <Findings group={group} />
    </TroubleRow>
  );
}

function Rules({
  group,
  sources,
}: {
  group: IstioHostGroup;
  sources: IstioSources | null;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      {group.routes.map((route) => (
        <RuleRow key={route.key} route={route} sources={sources} />
      ))}
    </div>
  );
}

function RuleRow({
  route,
  sources,
}: {
  route: IstioRoute;
  sources: IstioSources | null;
}) {
  const t = useT();
  return (
    <div className="grid grid-cols-[minmax(0,260px)_minmax(0,1fr)] items-baseline gap-x-3 text-[11.5px] text-fg-mut">
      <span className="truncate font-mono text-fg-mid">
        {route.matches.length === 0
          ? t("empty", "everyRequest")
          : route.matches
              .map((match) => describeMatch(match, t))
              .join(t("readings", "istioOrJoin"))}
        {route.protocol !== "http" && (
          <span className="ml-1 text-fg-fnt">{route.protocol}</span>
        )}
      </span>
      <span className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
        <span className="text-fg-fnt">{t("empty", "toTarget")}</span>
        {route.destinations.length === 0 ? (
          <span className="text-err">{t("empty", "nowhere")}</span>
        ) : (
          route.destinations.map((destination, index) => (
            <span key={index} className="flex items-baseline gap-x-1">
              {destination.weight !== null && (
                <span className="text-info">{destination.weight}%</span>
              )}
              {destination.service && !destination.external ? (
                <ResourceRef
                  kind="Service"
                  name={destination.service.name}
                  namespace={destination.service.namespace}
                  showKind={false}
                />
              ) : (
                <span className="font-mono text-fg-mid">
                  {destination.host}
                </span>
              )}
              {destination.subset && (
                <span className="font-mono text-fg-fnt">
                  /{destination.subset}
                </span>
              )}
            </span>
          ))
        )}
        <span className="text-fg-fnt">
          ·{" "}
          <ResourceRef
            kind="VirtualService"
            name={route.source.name}
            namespace={route.source.namespace}
            crd={KINDS.virtualServices}
            showKind={false}
          />
        </span>
        {sources === null && <span className="text-fg-fnt">…</span>}
      </span>
    </div>
  );
}

// --- the chain ----------------------------------------------------------

function HostChain({
  group,
  sources,
}: {
  group: IstioHostGroup;
  sources: IstioSources;
}) {
  const t = useT();
  const route = group.chainFor;
  const destination = route.destinations[0];
  const backing = destination
    ? backingOf(destination, route.source, sources)
    : null;
  const subsets = destination
    ? subsetsFor(
        destination,
        route.source.namespace,
        sources.destinationRules,
        sources.services
      )
    : { defined: [], anyRule: false };
  const serving = group.gateways.filter((gateway) => gateway.serves);
  const unread = route.matches.filter((match) => !fullyRead(match));

  return (
    <div className="flex flex-col gap-1">
      {group.routes.length > 1 && (
        <span className="text-[10px] text-fg-fnt">
          {t("empty", "theRuleFor")}{" "}
          {route.matches.length === 0
            ? t("empty", "everyRequest")
            : describeMatch(route.matches[0], t)}
        </span>
      )}
      <Chain>
        <Column label="Gateway">
          {group.meshOnly ? (
            <Cell under={t("empty", "noEdgeListener")}>
              {t("empty", "inMeshOnly")}
            </Cell>
          ) : group.gateways.length === 0 ? (
            <Cell bad under={t("empty", "namesNone")}>
              {t("empty", "noneLower")}
            </Cell>
          ) : serving.length === 0 ? (
            <Cell
              bad
              under={
                group.gateways.some((gateway) => gateway.gateway === null)
                  ? t("empty", "notInThisCluster")
                  : t("empty", "servesOtherHosts")
              }
            >
              {group.gateways.map((gateway) => gateway.named).join(", ")}
            </Cell>
          ) : (
            serving.map((gateway) => (
              <Cell key={gateway.named} under={gateway.ports.join(", ")}>
                {gateway.named}
              </Cell>
            ))
          )}
        </Column>
        <Column label="VirtualService">
          <Cell
            under={
              route.matches.length === 0
                ? t("empty", "everyRequest")
                : unread.length > 0
                  ? t("empty", "shownInFullBelow")
                  : describeMatch(route.matches[0], t)
            }
          >
            {route.source.name}
          </Cell>
        </Column>
        <Column label="DestinationRule">
          {!destination?.subset ? (
            <div className="rounded-[4px] border border-hair px-2 py-1 font-mono text-[11px] text-fg-fnt opacity-60">
              {t("empty", "noSubset")}
            </div>
          ) : (
            <Cell
              bad={!subsets.defined.includes(destination.subset)}
              under={
                subsets.defined.includes(destination.subset)
                  ? t("count", "ofN", { n: subsets.defined.join(", ") })
                  : subsets.anyRule
                    ? t("empty", "definesList", {
                        list:
                          subsets.defined.join(", ") || t("empty", "noSubsets"),
                      })
                    : t("empty", "noRuleNamesThisHost")
              }
            >
              {destination.subset}
            </Cell>
          )}
        </Column>
        <Column label="Service">
          {!destination ? (
            <Cell bad>{t("empty", "noneLower")}</Cell>
          ) : destination.external ? (
            <Cell under={t("empty", "outsideThisCluster")}>
              {destination.host}
            </Cell>
          ) : (
            <Cell
              bad={backing?.stop?.reason === "backendMissing"}
              under={`${destination.port ? `:${destination.port} · ` : ""}${destination.service?.namespace}`}
            >
              {destination.service?.name}
            </Cell>
          )}
        </Column>
        <Column label={t("columns", "published")}>
          {!destination || destination.external ? (
            <Cell under={t("empty", "notThisClustersPods")}>—</Cell>
          ) : !backing?.known ? (
            <Cell under={t("empty", "readingEndpoints")}>—</Cell>
          ) : backing.stop ? (
            <Cell bad under={t("empty", STOP_UNDER[backing.stop.reason])}>
              {t("count", "nPublished", { n: 0 })}
            </Cell>
          ) : (
            <Cell
              warn={backing.ready === 0 && backing.draining > 0}
              under={
                backing.draining > 0
                  ? t("count", "nDraining", { n: backing.draining })
                  : backing.notReady > 0
                    ? t("count", "nNotReady", { n: backing.notReady })
                    : t("count", "ofN", { n: backing.ready })
              }
            >
              {t("count", "nPublished", {
                n: backing.ready + backing.draining,
              })}
            </Cell>
          )}
        </Column>
      </Chain>
      {unread.length > 0 && <RawMatches matches={unread} />}
    </div>
  );
}

/**
 * A match this app could not read in full, printed as written.
 *
 * The same rule the Traefik page follows and the nginx snippets follow: a
 * wrong paraphrase of a routing rule is worse than the raw block, because
 * this time somebody believed it.
 */
function RawMatches({ matches }: { matches: MatchReading[] }) {
  const t = useT();
  return (
    <div className="mt-1 flex flex-col gap-1.5">
      {matches.map((match, index) => (
        <div key={index} className="border-l-2 border-hair pl-2.5">
          <p className="text-[11px] text-fg-mut">
            {match.refused
              ? t("empty", "matchShownAsWrittenBecause", {
                  reason: match.refused,
                })
              : t("empty", "matchFieldsNotInterpreted", {
                  n: match.unread.length,
                  list: match.unread
                    .map((line) => line.split(":")[0])
                    .join(", "),
                })}
          </p>
          <pre className="mt-0.5 select-text whitespace-pre-wrap break-all rounded-[4px] border border-hair bg-hover px-2 py-1 font-mono text-[11px] text-fg-mid">
            {match.raw}
          </pre>
        </div>
      ))}
    </div>
  );
}

// --- findings -----------------------------------------------------------

const STOP_UNDER: Record<ServiceStop["reason"], keyof typeof en.empty> = {
  backendMissing: "stopNoServiceToSendTo",
  selectsNothing: "stopSelectorMatchesNothing",
  noneReady: "stopRunningNoneReady",
  publishesNothing: "stopNoPortToSendTo",
};

function Findings({
  group,
  brief,
}: {
  group: IstioHostGroup;
  brief?: boolean;
}) {
  const t = useT();
  if (group.findings.length === 0) return null;
  const shown = brief ? group.findings.slice(0, 1) : group.findings;
  const hidden = brief ? group.findings.length - 1 : 0;

  return (
    <div className="flex flex-col gap-2">
      {shown.map((finding, index) => {
        const said = describeFinding(finding, t);
        return (
          <FindingBlock key={index} tone={finding.severity} title={said.title}>
            {!brief && said.note}
          </FindingBlock>
        );
      })}
      {hidden > 0 && (
        <span className="text-[11px] text-fg-fnt">
          {t("empty", "andMoreOpenRow", { n: hidden })}
        </span>
      )}
    </div>
  );
}

function describeFinding(
  finding: Finding,
  t: ReturnType<typeof useT>
): { title: string; note: string } {
  switch (finding.kind) {
    case "noGateway": {
      const missing = finding.gateways.filter(
        (gateway) => gateway.gateway === null
      );
      return {
        title: t("empty", "istioNoGatewayServes", { host: finding.host }),
        note:
          missing.length > 0
            ? t("empty", "istioGatewaysAbsentNote", {
                n: missing.length,
                list: missing.map((gateway) => gateway.named).join(", "),
              })
            : t("empty", "istioGatewaysCoverNothingNote", {
                n: finding.gateways.length,
                list: finding.gateways
                  .map((gateway) => gateway.named)
                  .join(", "),
              }),
      };
    }
    case "noSubset":
      return {
        title: t("empty", "istioSubsetUndefinedTitle", {
          name: finding.route.source.name,
          subset: finding.destination.subset ?? "",
        }),
        note: finding.anyRule
          ? t("empty", "istioSubsetRuleDeclaresNote", {
              host: finding.destination.host,
              declares:
                finding.defined.length > 0
                  ? t("empty", "istioSubsetDeclaredNot", {
                      list: finding.defined.join(", "),
                      subset: finding.destination.subset ?? "",
                    })
                  : t("empty", "istioNoSubsetsAtAll"),
            })
          : t("empty", "istioNoRuleNamesHostNote", {
              host: finding.destination.host,
              subset: finding.destination.subset ?? "",
            }),
      };
    case "weights": {
      return {
        title: t("empty", "istioWeightsTitle", { sum: finding.sum }),
        note: t("empty", "istioWeightsNote", {
          detail:
            finding.sum < 100
              ? t("empty", "istioWeightsUnder", { percent: 100 - finding.sum })
              : t("empty", "istioWeightsOver"),
        }),
      };
    }
    case "stop": {
      const said = describeStop(finding.stop, t);
      return {
        title: t("empty", "istioRouteResolves503", {
          detail: `${said.title.charAt(0).toLowerCase()}${said.title.slice(1)}`,
        }),
        note: said.note,
      };
    }
  }
}

// --- gateways -----------------------------------------------------------

/**
 * Every Gateway, and which hosts land on it.
 *
 * The reverse of the Routes tab's question, and the one that answers "why is
 * my VirtualService not receiving anything": a Gateway nothing binds to is
 * an edge listener with no routes behind it, which is as quiet a failure as
 * the other direction.
 */
function GatewaysTab({
  gateways,
  groups,
  loading,
}: {
  gateways: CustomResourceInfo[];
  groups: IstioHostGroup[];
  loading: boolean;
}) {
  const t = useT();
  if (loading)
    return <p className="text-xs text-fg-fnt">{t("empty", "readingMesh")}</p>;
  if (gateways.length === 0) {
    return (
      <p className="max-w-[64ch] text-xs text-fg-mut">
        {t("empty", "istioNoGatewayObjects")}
      </p>
    );
  }

  return (
    <Section>
      <SectionHeader
        title="Gateways"
        count={gateways.length}
        description={t("empty", "istioGatewaysDescription")}
      />
      <div className="flex flex-col">
        {gateways.map((gateway) => {
          const bound = groups.filter((group) =>
            group.gateways.some(
              (named) => named.gateway === gateway && named.serves
            )
          );
          const named = groups.filter((group) =>
            group.gateways.some((entry) => entry.gateway === gateway)
          );
          const servers =
            (
              (gateway.spec ?? {}) as {
                servers?: Array<{
                  hosts?: string[];
                  port?: { number?: number; protocol?: string };
                }>;
              }
            ).servers ?? [];

          return (
            <div
              key={`${gateway.namespace}/${gateway.name}`}
              className="grid grid-cols-[minmax(0,200px)_minmax(0,1fr)_minmax(0,200px)] items-baseline gap-x-3 border-b border-hair py-1.5 text-[11.5px]"
            >
              <span className="min-w-0 truncate">
                <ResourceRef
                  kind="Gateway"
                  name={gateway.name}
                  namespace={gateway.namespace}
                  crd={KINDS.gateways}
                  showKind={false}
                />
              </span>
              <span className="truncate font-mono text-fg-mut">
                {servers
                  .map(
                    (server) =>
                      `${server.port?.protocol ?? "?"}:${server.port?.number ?? "?"} → ${
                        server.hosts?.join(", ") ?? "*"
                      }`
                  )
                  .join(" · ") || t("empty", "noServers")}
              </span>
              {bound.length === 0 ? (
                <span className="text-warn">
                  {named.length > 0
                    ? t("count", "hostsNameItNoneCovered", { n: named.length })
                    : t("empty", "nothingBindsToIt")}
                </span>
              ) : (
                <span className="truncate text-fg-mut">
                  {t("count", "hosts", { n: bound.length })}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </Section>
  );
}

// --- subsets ------------------------------------------------------------

/**
 * Every subset a DestinationRule defines, and whether anything routes to it.
 *
 * Both directions are findings, and neither is visible anywhere else: a
 * route to a subset nothing defines is a 503, and a subset nothing routes to
 * is a label selector doing nothing.
 */
function SubsetsTab({
  rules,
  groups,
  sources,
  loading,
}: {
  rules: CustomResourceInfo[];
  groups: IstioHostGroup[];
  sources: IstioSources | null;
  loading: boolean;
}) {
  const t = useT();
  if (loading)
    return <p className="text-xs text-fg-fnt">{t("empty", "readingMesh")}</p>;
  if (rules.length === 0) {
    return (
      <p className="max-w-[64ch] text-xs text-fg-mut">
        {t("empty", "istioNoDestinationRules")}
      </p>
    );
  }

  const routed = new Set(
    groups.flatMap((group) =>
      group.routes.flatMap((route) =>
        route.destinations.flatMap((destination): string[] =>
          destination.subset
            ? [
                `${destination.service?.name ?? destination.host}/${destination.subset}`,
              ]
            : []
        )
      )
    )
  );

  const missing = groups.flatMap((group) =>
    group.findings.flatMap((finding): Destination[] =>
      finding.kind === "noSubset" ? [finding.destination] : []
    )
  );

  return (
    <div className="flex flex-col gap-[22px]">
      {missing.length > 0 && (
        <Section>
          <SectionHeader
            title={t("nav", "routedDefinedNowhere")}
            count={missing.length}
            description={t("empty", "istioRoutedDefinedNowhereNote")}
          />
          <div className="flex flex-col">
            {missing.map((destination, index) => (
              <div
                key={index}
                className="flex items-baseline gap-2 border-b border-hair py-1.5 text-[11.5px]"
              >
                <span className="font-mono text-err">
                  {destination.host}/{destination.subset}
                </span>
              </div>
            ))}
          </div>
        </Section>
      )}

      <Section>
        <SectionHeader
          title={t("nav", "subsets")}
          count={rules.length}
          description={t("empty", "istioSubsetsDescription")}
        />
        <div className="flex flex-col">
          {rules.map((rule) => {
            const spec = (rule.spec ?? {}) as {
              host?: string;
              subsets?: Array<{ name?: string }>;
            };
            const subsets = (spec.subsets ?? []).flatMap((subset) =>
              subset.name ? [subset.name] : []
            );
            const short = (spec.host ?? "").split(".")[0];
            const unused = subsets.filter(
              (subset) => !routed.has(`${short}/${subset}`)
            );

            return (
              <div
                key={`${rule.namespace}/${rule.name}`}
                className="grid grid-cols-[minmax(0,200px)_minmax(0,200px)_minmax(0,1fr)] items-baseline gap-x-3 border-b border-hair py-1.5 text-[11.5px]"
              >
                <span className="min-w-0 truncate">
                  <ResourceRef
                    kind="DestinationRule"
                    name={rule.name}
                    namespace={rule.namespace}
                    crd={KINDS.destinationRules}
                    showKind={false}
                  />
                </span>
                <span className="truncate font-mono text-fg-mut">
                  {spec.host ?? "—"}
                </span>
                <span className="truncate text-fg-mut">
                  {subsets.length === 0 ? (
                    <span className="text-fg-fnt">
                      {t("empty", "noSubsetsTrafficPolicyOnly")}
                    </span>
                  ) : unused.length === subsets.length ? (
                    <span className="text-warn">
                      {t("count", "subsetsNothingRoutesTo", {
                        n: subsets.length,
                        list: subsets.join(", "),
                      })}
                    </span>
                  ) : (
                    subsets.join(", ")
                  )}
                </span>
              </div>
            );
          })}
        </div>
        {sources === null && (
          <p className="text-[11px] text-fg-fnt">
            {t("empty", "checkingWhatIsBehind")}
          </p>
        )}
      </Section>
    </div>
  );
}
