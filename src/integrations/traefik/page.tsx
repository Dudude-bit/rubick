/**
 * Traefik's page: the routing table, pivoted the way the question is asked.
 *
 * It opens on Routes, like every vendor page in this tree, because "what is
 * broken" is what somebody who opened an integration page is asking. Map is a
 * real screen and stays a click away.
 *
 * One request's journey is a chain in fixed order — entry point → rule →
 * middleware → service → pods — so it is drawn as one, left to right, for the
 * host the reader opened. Map answers what a chain cannot: which entry points
 * carry which hostnames, and which land on the same Service. Layered and
 * deterministic rather than force-directed, so nothing rearranges when a pod
 * restarts.
 *
 * Ordered by trouble, not by name: the reader has one URL that is not working
 * and seventy-nine that are. A host with a finding opens itself and every
 * other is one line; past {@link AUTO_OPEN} troubled hosts nothing opens
 * itself, because a screen where everything is expanded emphasises nothing.
 *
 * Links go into this app for everything the cluster owns. Traefik's own
 * dashboard is deliberately not linked: it is bound to an entry point with no
 * route to it from outside, and a button that leads to a connection error is
 * worse than no button.
 */

import { sayWords } from "@/i18n/say";
import { Fragment, useMemo, type ReactNode } from "react";
import {
  BACKING_NOT_READ,
  backingFrom,
  edgeTlsWords,
  hostSeverity,
  useRouteCertificates,
  STOP_UNDER,
} from "../ingress";
import { Link } from "react-router-dom";
import { Box, Filter, Globe, Network, Plug } from "lucide-react";

import { Section, SectionHeader } from "@/components/ui/section";
import { DetailTabs } from "@/components/resources/DetailTabs";
import { ResourceRef } from "@/components/resources/ResourceRef";
import { RenewalNote } from "@/components/resources/IssuanceChain";
import {
  countMark,
  severityMark,
  viewGlyph,
  type DetailTab,
} from "@/components/resources/detail-tab";
import { useCertificateIssuance } from "@/hooks/useCertificateIssuance";
import { describeStop } from "@/lib/connections";
import { crdObjectPath, troubleMark, summariseNames } from "../kit";
import {
  BackingUnread,
  TroubleList,
  Chain,
  Cell,
  Column,
  Finding as FindingBlock,
  TroubleRow,
  VendorReadFailure,
  FindingList,
} from "../page-kit";
import { RoutingMap } from "../routing-map";
import { useFrontingTls } from "../fronting-tls";
import { ProxyControllerTab } from "../proxy-controller";
import { routingMap } from "./map";
import {
  servedGroupName,
  useBacking,
  useController,
  useRouteSources,
  sourcesFrom,
  type ControllerInfo,
} from "./data";
import {
  allRoutes,
  PROXY_LABEL,
  backingOf,
  boundEntryPoints,
  duplicatedServiceNames,
  hostGroups,
  hostState,
  edgeTls,
  middlewareType,
  middlewareUses,
  traefikClasses,
  type Finding,
  type HostGroup,
  type TraefikRoute,
  type TraefikSources,
  UNNAMED_TARGET,
} from "./model";
import { describePath, fullyRead } from "./rule";
import { problemWords } from "@/lib/certificates";
import { useSearchParam } from "@/hooks/useSearchParam";
import { useT } from "@/i18n/useT";

/** Past this many troubled hosts, nothing opens itself. */
const AUTO_OPEN = 8;

export default function TraefikPage() {
  const t = useT();
  const [tab, setTab] = useSearchParam("tab", "routes");

  const routeSources = useRouteSources();
  const backing = useBacking();
  const controller = useController();

  const routes = useMemo(
    () =>
      routeSources.data
        ? allRoutes({
            ...routeSources.data,
            ...BACKING_NOT_READ,
            entryPoints: [],
          })
        : [],
    [routeSources.data]
  );
  const certificates = useRouteCertificates(routes);

  const upstreamTls = useFrontingTls(
    routeSources.data?.ingresses,
    backing.data?.services,
    PROXY_LABEL
  );

  const sources: TraefikSources | null = useMemo(
    () =>
      routeSources.data
        ? {
            ...sourcesFrom(
              routeSources.data,
              backingFrom(backing.data, backing.error),
              controller.data,
              certificates
            ),
            upstreamTls,
          }
        : null,
    [
      routeSources.data,
      backing.data,
      backing.error,
      controller.data,
      certificates,
      upstreamTls,
    ]
  );

  const groups = useMemo(() => (sources ? hostGroups(sources) : []), [sources]);

  if (routeSources.error) {
    return (
      <VendorReadFailure
        title={t("empty", "couldNotReadRouting")}
        body={t("empty", "traefikRoutingRequestFailed")}
        error={routeSources.error}
        onRetry={() => void routeSources.refetch()}
      />
    );
  }

  const uses = sources
    ? middlewareUses(sources.middlewares, allRoutesOf(groups))
    : [];
  const unused = uses.filter((use) => use.usedBy.length === 0).length;

  const tabs: DetailTab[] = [
    {
      id: "routes",
      label: t("nav", "routes"),
      glyph: viewGlyph(Globe),
      mark: troubleMark(
        groups.map(hostSeverity),
        (n, total) => t("count", "hostsNeedAttention", { n, total }),
        (n, total) => t("count", "notCheckedOfTotal", { n, total })
      ),
      content: (
        <RoutesTab
          groups={groups}
          sources={sources}
          loading={routeSources.isPending}
          backingLoading={backing.isPending}
        />
      ),
    },
    {
      id: "map",
      label: t("nav", "map"),
      glyph: viewGlyph(Network),
      // A shape, not a verdict. The colour belongs on the tab the reader
      // lands on and triages from; a red mark on the tab beside it would
      // send them away from the list that says which host is broken. Nothing
      // routed is no number either — every other mark on this page is absent
      // at zero rather than printing one.
      mark: groups.length > 0 ? countMark(groups.length) : undefined,
      content: (
        <MapTab
          groups={groups}
          sources={sources}
          loading={routeSources.isPending}
          backingLoading={backing.isPending}
        />
      ),
    },
    {
      id: "middlewares",
      label: "Middlewares",
      glyph: viewGlyph(Filter),
      mark:
        unused > 0
          ? severityMark("warn", t("count", "middlewaresUnused", { n: unused }))
          : countMark(uses.length),
      content: <MiddlewaresTab uses={uses} />,
    },
    {
      id: "entrypoints",
      label: t("nav", "entryPoints"),
      glyph: viewGlyph(Plug),
      mark:
        controller.data && controller.data.entryPoints.length > 0
          ? countMark(controller.data.entryPoints.length)
          : undefined,
      content: <EntryPointsTab controller={controller.data} groups={groups} />,
    },
    {
      id: "controller",
      label: t("nav", "controller"),
      glyph: viewGlyph(Box),
      content: <ControllerTab controller={controller.data} sources={sources} />,
    },
  ];

  return (
    <div className="flex flex-col gap-[22px]">
      <SectionHeader
        title="Traefik"
        count={
          routeSources.isPending
            ? undefined
            : t("count", "hostsAcrossNamespaces", { n: groups.length })
        }
        description={t("empty", "traefikPageDescription")}
      />
      <DetailTabs tabs={tabs} activeTab={tab} onTabChange={setTab} />
    </div>
  );
}

function allRoutesOf(groups: HostGroup[]): TraefikRoute[] {
  return groups.flatMap((group) => group.routes);
}

// --- the map ------------------------------------------------------------

/**
 * The whole routing layer at once, ordered by trouble like everything else.
 *
 * No filter box of its own: the map *is* the overview, and narrowing it to
 * one host would leave three boxes and a line — which is the chain the Routes
 * tab already draws better. Clicking a host goes there with that host in the
 * filter, which is the same gesture and lands somewhere that can answer.
 */
function MapTab({
  groups,
  sources,
  loading,
  backingLoading,
}: {
  groups: HostGroup[];
  sources: TraefikSources | null;
  loading: boolean;
  backingLoading: boolean;
}) {
  const t = useT();
  const data = useMemo(
    () => (sources ? routingMap(groups, sources, t) : null),
    [groups, sources, t]
  );

  if (loading) {
    return (
      <p className="text-xs text-fg-fnt">{t("empty", "readingRoutingTable")}</p>
    );
  }
  if (!data || groups.length === 0) return <NothingRoutes />;

  const broken = groups.filter((group) => group.worst === "err").length;
  const worthALook = groups.filter((group) => group.worst === "warn").length;
  const unchecked = groups.filter(
    (group) => hostSeverity(group) === "unknown"
  ).length;

  return (
    <div className="flex flex-col gap-2">
      <p className="text-[11px] text-fg-fnt">
        {broken > 0
          ? `${t("count", "hostsBrokenOfTotal", { n: broken, total: groups.length })}${worthALook > 0 ? ` · ${t("count", "worthALook", { n: worthALook })}` : ""}`
          : worthALook > 0
            ? `${t("empty", "nothingBroken")} · ${t("count", "worthALookOfTotal", { n: worthALook, total: groups.length })}`
            : unchecked > 0
              ? t("count", "notCheckedOfTotal", {
                  n: unchecked,
                  total: groups.length,
                })
              : t("count", "hostsNoneWithProblem", { n: groups.length })}
        {backingLoading && ` · ${t("empty", "checkingWhatIsBehind")}`}
      </p>
      <BackingUnread error={sources?.backingError ?? null} />
      <RoutingMap data={data} />
      <p className="text-[11px] text-fg-fnt">
        {t("empty", "traefikRestOnNodeHint")}
      </p>
    </div>
  );
}

/** The one thing both the map and the list say when there is no routing. */
function NothingRoutes() {
  const t = useT();
  return (
    <div className="max-w-[64ch]">
      <p className="text-xs text-fg-mut">
        {t("empty", "traefikRunningNothingRoutes")}
      </p>
      <p className="mt-1.5 text-[11px] text-fg-fnt">
        {t("empty", "traefikNoRouteClaimsClass")}
      </p>
    </div>
  );
}

// --- routes -------------------------------------------------------------

function RoutesTab({
  groups,
  sources,
  loading,
  backingLoading,
}: {
  groups: HostGroup[];
  sources: TraefikSources | null;
  loading: boolean;
  backingLoading: boolean;
}) {
  const t = useT();
  // Once per table, not per row: the same set decides every row's spelling.
  const duplicated = useMemo(() => duplicatedServiceNames(groups), [groups]);

  if (loading) {
    return (
      <p className="text-xs text-fg-fnt">{t("empty", "readingRoutingTable")}</p>
    );
  }

  if (groups.length === 0) return <NothingRoutes />;

  return (
    <TroubleList
      items={groups}
      severityOf={severityOfGroup}
      searchable={searchableGroup}
      filter={{
        placeholder: t("action", "filterByHostServiceObject"),
        label: t("action", "filterHosts"),
      }}
      autoOpen={{ when: "err", upTo: AUTO_OPEN }}
      summary={{
        brokenFirst: (n, total) => t("count", "brokenAndFirst", { n, total }),
        nothingBroken: t("empty", "nothingBroken"),
        allWell: (n) => t("count", "hostsNoneWithProblem", { n }),
      }}
      noMatch={() => t("empty", "noHostServiceObjectMatches")}
      aside={
        <>
          {backingLoading && (
            <span className="text-[11px] text-fg-fnt">
              {t("empty", "checkingWhatIsBehind")}
            </span>
          )}
          <BackingUnread error={sources?.backingError ?? null} />
        </>
      }
      keyOf={(group, index) => group.host ?? `catch-all-${index}`}
      renderRow={(group, { openByDefault }) => (
        <HostRow
          group={group}
          sources={sources}
          duplicated={duplicated}
          openByDefault={openByDefault}
        />
      )}
    />
  );
}

const severityOfGroup = hostSeverity;

const searchableGroup = (group: HostGroup) => [
  group.host,
  ...group.routes.flatMap((route) => [
    route.source.name,
    route.source.namespace,
    route.service?.name ?? route.resourceBackend,
  ]),
];

function HostRow({
  group,
  sources,
  openByDefault,
  duplicated,
}: {
  group: HostGroup;
  sources: TraefikSources | null;
  openByDefault: boolean;
  duplicated: Set<string>;
}) {
  const t = useT();
  const state = hostState(group, sources?.backingError ?? null, t);
  const tls = group.tlsSecrets[0];
  // Where the certificate is, when it is not here. Stated rather than merely
  // not warned about: a reader who knows TLS ends at the load balancer learns
  // nothing from silence, and a reader who does not is the one this line is
  // for.
  const edge = sources
    ? edgeTls(group.host, sources)
    : { at: "unknown" as const };
  // A route that declares no entry point is bound to all of them, and
  // enumerating four names to say "all of them" is longer and says less.
  const everywhere = group.routes.some((route) => !route.entryPoints);
  const entryPoints = sources
    ? [
        ...new Set(
          group.routes.flatMap((route) =>
            boundEntryPoints(route, sources.entryPoints).map(
              (entry) => entry.name
            )
          )
        ),
      ]
    : [];

  return (
    <TroubleRow
      title={group.host ?? t("empty", "anyHost")}
      copy={group.host ?? undefined}
      meta={
        <>
          {t("count", "paths", { n: group.routes.length })}
          {entryPoints.length > 0 &&
            ` · ${everywhere ? t("empty", "everyEntryPoint") : summariseNames(entryPoints)}`}
          {tls
            ? ` · ${t("empty", "tlsFrom", { name: tls.secretName })}`
            : ` · ${edgeTlsWords(edge, t)}`}
        </>
      }
      state={state}
      openByDefault={openByDefault}
      // A finding is why the reader is here, so it survives the row being
      // closed — collapsing hides the detail, never the problem.
      brief={
        group.findings.length > 0 ? <Findings group={group} brief /> : undefined
      }
    >
      <Paths group={group} sources={sources} duplicated={duplicated} />
      {sources && <HostChain group={group} sources={sources} />}
      <Findings group={group} />
    </TroubleRow>
  );
}

function Paths({
  group,
  sources,
  duplicated,
}: {
  group: HostGroup;
  sources: TraefikSources | null;
  duplicated: Set<string>;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      {group.routes.map((route) => (
        <PathRow
          key={route.key}
          route={route}
          sources={sources}
          duplicated={duplicated}
        />
      ))}
    </div>
  );
}

function PathRow({
  route,
  sources,
  duplicated,
}: {
  route: TraefikRoute;
  sources: TraefikSources | null;
  duplicated: Set<string>;
}) {
  const t = useT();
  const backing = sources ? backingOf(route, sources) : null;

  return (
    <div className="grid grid-cols-[minmax(0,190px)_minmax(0,1fr)_auto] items-baseline gap-x-3 text-[11.5px] text-fg-mut">
      <span className="truncate font-mono text-fg-mid">
        {describePath(route.clause.path, t)}
        {route.pathType && route.pathType !== "Prefix" && (
          <span className="ml-1 text-fg-fnt">{route.pathType}</span>
        )}
      </span>
      <span className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
        {route.middlewares.length > 0 && (
          <>
            <span className="text-fg-fnt">{t("empty", "throughWord")}</span>
            <span className="font-mono text-fg-mid">
              {route.middlewares.map((m) => m.name).join(" → ")}
            </span>
          </>
        )}
        <span className="text-fg-fnt">{t("empty", "toTarget")}</span>
        {route.service ? (
          <>
            {route.service.kubernetes ? (
              <>
                {/* Two Services wearing one name render as the same word;
                    the namespace is drawn for exactly those. */}
                <ResourceRef
                  kind="Service"
                  name={route.service.name}
                  namespace={route.service.namespace}
                  showKind={false}
                  showNamespace={duplicated.has(route.service.name)}
                />
              </>
            ) : (
              // Traefik's own internals have no page in this app, and a link
              // to a Service that does not exist is a second dead end.
              <span className="font-mono text-fg-mid">
                {route.service.name}
              </span>
            )}
            {route.service.port !== "" && (
              <span className="text-fg-fnt">:{route.service.port}</span>
            )}
          </>
        ) : route.resourceBackend ? (
          <span className="font-mono text-fg-mid">{route.resourceBackend}</span>
        ) : (
          <span className="text-err">{t("empty", "noServiceBackend")}</span>
        )}
        <SourceRef route={route} />
      </span>
      <span className="text-[11px] text-fg-fnt">
        {route.resourceBackend
          ? t("empty", "anApiObject")
          : !route.service?.kubernetes
            ? t("empty", "insideTheProxy")
            : backing && !backing.known
              ? backing.error
                ? t("empty", "unknownLower")
                : "…"
              : backing?.stop
                ? "—"
                : backing
                  ? t("count", "nReady", { n: backing.ready })
                  : ""}
      </span>
    </div>
  );
}

/** The object this row came from, which is the thing the reader edits. */
function SourceRef({ route }: { route: TraefikRoute }) {
  if (route.source.kind === "Ingress") {
    return (
      <span className="text-fg-fnt">
        ·{" "}
        <ResourceRef
          kind="Ingress"
          name={route.source.name}
          namespace={route.source.namespace}
          showKind={false}
          showNamespace
        />
      </span>
    );
  }
  return (
    <span className="text-fg-fnt">
      ·{" "}
      <ResourceRef
        kind="IngressRoute"
        name={route.source.name}
        namespace={route.source.namespace}
        crd={`ingressroutes.${servedGroupName()}`}
        showKind={false}
        showNamespace
      />
    </span>
  );
}

// --- the chain ----------------------------------------------------------

/**
 * One host's chain, in the order a request travels it.
 *
 * Drawn for one route rather than for all of them: a host with twenty paths
 * would otherwise be twenty chains, and the reader came for the one that
 * stopped. Which one it is drawn for is said above it, not left to be
 * guessed.
 */
function HostChain({
  group,
  sources,
}: {
  group: HostGroup;
  sources: TraefikSources;
}) {
  const t = useT();
  const route = group.chainFor;
  const backing = backingOf(route, sources);
  const entryPoints = boundEntryPoints(route, sources.entryPoints);
  const tls = route.tlsSecret;

  return (
    <div className="flex flex-col gap-1">
      {group.routes.length > 1 && (
        <span className="text-[10px] text-fg-fnt">
          {t("empty", "thePathThrough", {
            path: describePath(route.clause.path, t),
          })}
        </span>
      )}
      <Chain>
        <Column label={t("columns", "entryPoint")}>
          {entryPoints.length === 0 ? (
            <Cell under={t("empty", "notReadLower")}>
              {t("empty", "unknownLower")}
            </Cell>
          ) : route.entryPoints === null ? (
            // The object names none, which in Traefik means all of them.
            // Stacking four cells to say so makes the chain taller than the
            // answer is worth.
            <Cell under={entryPoints.map((entry) => entry.name).join(", ")}>
              {t("empty", "everyEntryPoint")}
            </Cell>
          ) : (
            entryPoints.map((entry) => (
              <Cell
                key={entry.name}
                under={`${entry.address ?? "?"}${entry.tls ? ", TLS" : ""}`}
              >
                {entry.name}
              </Cell>
            ))
          )}
        </Column>
        <Column label={t("columns", "rule")}>
          <Cell
            under={
              route.rule.raw === null
                ? t("empty", "kindRule", { kind: route.source.kind })
                : fullyRead(route.rule)
                  ? undefined
                  : t("empty", "shownInFullBelow")
            }
          >
            {group.host ?? t("empty", "anyHost")}
            {route.clause.path ? ` ${describePath(route.clause.path, t)}` : ""}
          </Cell>
        </Column>
        <Column label="Middleware">
          {route.middlewares.length === 0 ? (
            <div className="rounded-[4px] border border-hair px-2 py-1 font-mono text-[11px] text-fg-fnt opacity-60">
              {t("empty", "noneLower")}
            </div>
          ) : (
            route.middlewares.map((middleware) => (
              <Cell
                key={`${middleware.namespace}/${middleware.name}`}
                under={middlewareDetail(
                  sources,
                  middleware.name,
                  middleware.namespace,
                  t
                )}
              >
                <ResourceRef
                  kind="Middleware"
                  name={middleware.name}
                  namespace={middleware.namespace}
                  crd={`middlewares.${servedGroupName()}`}
                  showKind={false}
                />
              </Cell>
            ))
          )}
        </Column>
        <Column label="Service">
          {route.service ? (
            <Cell
              bad={backing.stop?.reason === "backendMissing"}
              under={
                route.service.kubernetes
                  ? `:${route.service.port || "?"} · ${route.service.namespace}`
                  : t("empty", "traefiksOwnNotService")
              }
            >
              {route.service.kubernetes ? (
                <ResourceRef
                  kind="Service"
                  name={route.service.name}
                  namespace={route.service.namespace}
                  showKind={false}
                />
              ) : (
                route.service.name
              )}
            </Cell>
          ) : route.resourceBackend ? (
            // An API object, not a Service. It has no endpoints by design
            // and the app cannot see inside it, so nothing is claimed.
            <Cell under={t("empty", "apiObjectNotService")}>
              {route.resourceBackend}
            </Cell>
          ) : (
            <Cell bad>{t("empty", "noneLower")}</Cell>
          )}
        </Column>
        <Column label={t("columns", "published")}>
          {route.resourceBackend ? (
            <Cell under={t("empty", "notAService")}>—</Cell>
          ) : !route.service?.kubernetes ? (
            <Cell under={t("empty", "insideTheProxy")}>
              {t("empty", "notPods")}
            </Cell>
          ) : !backing.known ? (
            <Cell
              under={t(
                "empty",
                backing.error ? "endpointsUnread" : "readingEndpoints"
              )}
              title={backing.error ?? undefined}
            >
              —
            </Cell>
          ) : backing.stop ? (
            <Cell bad under={t("empty", STOP_UNDER[backing.stop.reason])}>
              {t("count", "nPublished", { n: 0 })}
            </Cell>
          ) : (
            <Cell
              // A draining address is still the one traffic goes to, so the
              // column says so instead of counting it as an outage.
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
      {tls && (
        <span className="text-[11px] text-fg-fnt">
          {t("empty", "servedUnder")}{" "}
          <ResourceRef
            kind="Secret"
            name={tls}
            namespace={route.source.namespace}
            showKind={false}
          />
        </span>
      )}
      {/* A rule this app could not read in full is printed as written and
          said to be as written. A wrong paraphrase of a routing rule is
          worse than the raw string. */}
      {route.rule.raw !== null && !fullyRead(route.rule) && (
        <RawRule route={route} />
      )}
    </div>
  );
}

function RawRule({ route }: { route: TraefikRoute }) {
  const t = useT();
  const { rule } = route;
  return (
    <div className="mt-1 border-l-2 border-hair pl-2.5">
      <p className="text-[11px] text-fg-mut">
        {rule.refused
          ? t("empty", "ruleShownAsWrittenBecause", {
              reason: sayWords(rule.refused, t),
            })
          : t("empty", "shownExactlyAsWritten", {
              n: rule.unread.length,
              list: rule.unread.join(", "),
            })}
      </p>
      <p className="mt-0.5 select-text break-all font-mono text-[11px] text-fg-mid">
        {rule.raw}
      </p>
    </div>
  );
}

function middlewareDetail(
  sources: TraefikSources,
  name: string,
  namespace: string,
  t: ReturnType<typeof useT>
): string | undefined {
  const found = sources.middlewares.find(
    (middleware) =>
      middleware.name === name && (middleware.namespace ?? "") === namespace
  );
  if (!found) return t("empty", "notFoundInThisCluster");
  return middlewareType(found) ?? undefined;
}

// --- findings -----------------------------------------------------------

// A closed row already carries its state in the word at its right end, so
// only a finding that says more than that word earns a line on it — which
// on a cluster of eighty plain-HTTP hosts is the difference between eighty
// rows and a hundred and sixty.
const saysMoreThanTheRow = (finding: HostGroup["findings"][number]) =>
  finding.kind !== "clear";

function Findings({ group, brief }: { group: HostGroup; brief?: boolean }) {
  const issuance = useCertificateIssuance(
    group.tlsSecrets[0]?.namespace,
    group.tlsSecrets.map((secret) => secret.secretName)
  );

  return (
    <FindingList
      findings={group.findings}
      brief={brief}
      worthRepeating={saysMoreThanTheRow}
      render={(finding) => (
        <FindingLine finding={finding} brief={brief} issuance={issuance} />
      )}
    />
  );
}

function FindingLine({
  finding,
  brief,
  issuance,
}: {
  finding: Finding;
  brief?: boolean;
  issuance: ReturnType<typeof useCertificateIssuance>;
}) {
  const t = useT();
  const said = describeFinding(finding, t);
  return (
    <FindingBlock tone={finding.severity} title={said.title}>
      {!brief && said.note}
      {/* Core above, extension below, in that order and never the other way
          round: the finding reads whole on a cluster with cert-manager
          nowhere in it. */}
      {!brief && finding.kind === "certificate" && (
        <RenewalNote issuance={issuance} secretName={finding.secretName} />
      )}
    </FindingBlock>
  );
}

/** One object, linked, the way the reader will go and edit it. */
function objectRef(route: TraefikRoute): ReactNode {
  return (
    <span>
      {route.source.kind}{" "}
      <ResourceRef
        kind={route.source.kind}
        name={route.source.name}
        namespace={route.source.namespace}
        crd={
          route.source.kind === "IngressRoute"
            ? `ingressroutes.${servedGroupName()}`
            : undefined
        }
        showKind={false}
        showNamespace
      />
    </span>
  );
}

/** Each *object* once — two routers of one object are one thing to edit. */
function objectRefs(
  routes: TraefikRoute[],
  t: ReturnType<typeof useT>
): ReactNode {
  const unique = [
    ...new Map(
      routes.map((route) => [
        `${route.source.kind}/${route.source.namespace}/${route.source.name}`,
        route,
      ])
    ).values(),
  ];
  return unique.map((route, index) => (
    <Fragment key={`${route.source.namespace}/${route.source.name}`}>
      {index > 0 &&
        (index === unique.length - 1 ? ` ${t("empty", "listAnd")} ` : ", ")}
      {objectRef(route)}
    </Fragment>
  ));
}

function describeFinding(
  finding: Finding,
  t: ReturnType<typeof useT>
): {
  title: string;
  note: ReactNode;
} {
  switch (finding.kind) {
    case "stop": {
      // The same three sentences the traffic chain uses, so "no pod carries
      // app=promo" reads identically whether it was reached from a
      // Deployment or from a hostname.
      const said = describeStop(finding.stop, t);
      return {
        title: t("empty", "everyRequest502", {
          reason: `${said.title.charAt(0).toLowerCase()}${said.title.slice(1)}`,
        }),
        note: said.note,
      };
    }
    case "clear":
      return {
        title: t("empty", "servedInClearTitle"),
        note: t("empty", "traefikClearNote", {
          n: finding.entryPoints.length,
          list: finding.entryPoints.join(", "),
        }),
      };
    case "duplicate":
      return {
        title: t("empty", "twoObjectsClaimPath", { path: finding.path }),
        note: finding.winner ? (
          <>
            {objectRef(finding.winner)}{" "}
            {t("empty", "traefikDuplicateWinner", {
              because:
                finding.winner.priority !== null
                  ? t("empty", "traefikPriorityDeclared", {
                      n: finding.winner.priority,
                    })
                  : t("empty", "traefikPriorityLongest"),
            })}
          </>
        ) : finding.tied ? (
          <>
            {objectRefs(finding.routes, t)} {t("empty", "traefikDuplicateTied")}
          </>
        ) : (
          <>
            {objectRefs(finding.routes, t)}{" "}
            {t("empty", "traefikDuplicateUnsettled")}
          </>
        ),
      };
    case "certificate": {
      if (!finding.expiry) {
        return {
          title: t("empty", "secretNotACertificate", {
            name: finding.secretName,
          }),
          note: finding.read?.problem
            ? problemWords(finding.read.problem, t)
            : t("empty", "secretNotParsable"),
        };
      }
      return {
        title: `${finding.secretName} ${finding.expiry.text}`,
        note: t("empty", "certExpiryBrowserNote"),
      };
    }
  }
}

// --- middlewares --------------------------------------------------------

function MiddlewaresTab({ uses }: { uses: ReturnType<typeof middlewareUses> }) {
  const t = useT();
  if (uses.length === 0) {
    return (
      <p className="max-w-[64ch] text-xs text-fg-mut">
        {t("empty", "noMiddlewareObjects")}
      </p>
    );
  }

  return (
    <Section>
      <SectionHeader
        title="Middlewares"
        count={uses.length}
        description={t("empty", "middlewaresDescription")}
      />
      <div className="flex flex-col">
        {uses.map((use) => (
          <div
            key={`${use.middleware.namespace}/${use.middleware.name}`}
            className="grid grid-cols-[minmax(0,220px)_minmax(0,140px)_minmax(0,1fr)] items-baseline gap-x-3 border-b border-hair py-1.5 text-[11.5px]"
          >
            <Link
              to={crdObjectPath(
                `middlewares.${servedGroupName()}`,
                use.middleware.namespace,
                use.middleware.name
              )}
              className="truncate font-mono text-info hover:underline"
            >
              {use.middleware.name}
            </Link>
            <span className="truncate font-mono text-fg-mid">
              {use.type ?? "—"}
            </span>
            {use.usedBy.length === 0 ? (
              <span className="text-warn">
                {t("empty", "middlewareUnreferenced")}
              </span>
            ) : (
              <span className="truncate text-fg-mut">
                {[
                  ...new Set(
                    use.usedBy.map(
                      (route) => `${route.source.kind} ${route.source.name}`
                    )
                  ),
                ].join(", ")}
              </span>
            )}
          </div>
        ))}
      </div>
    </Section>
  );
}

// --- entry points -------------------------------------------------------

function EntryPointsTab({
  controller,
  groups,
}: {
  controller: ControllerInfo | undefined;
  groups: HostGroup[];
}) {
  const t = useT();
  if (!controller) {
    return (
      <p className="text-xs text-fg-fnt">{t("empty", "readingTheProxy")}</p>
    );
  }
  if (controller.entryPoints.length === 0) {
    return (
      <div className="max-w-[64ch]">
        <p className="text-xs text-fg-mut">
          {t("empty", "cannotSayWhatTraefikListensOn")}
        </p>
        <p className="mt-1.5 text-[11px] text-fg-fnt">
          {controller.problem
            ? sayWords(controller.problem, t)
            : t("empty", "entryPointsAreStatic")}
        </p>
      </div>
    );
  }

  return (
    <Section>
      <SectionHeader
        title={t("nav", "entryPoints")}
        count={controller.entryPoints.length}
        description={t("empty", "entryPointsDescription")}
      />
      <PlainEntryPointNote controller={controller} />
      <div className="flex flex-col">
        {controller.entryPoints.map((entry) => {
          const landing = groups.filter((group) =>
            group.routes.some(
              (route) =>
                !route.entryPoints || route.entryPoints.includes(entry.name)
            )
          );
          return (
            <div
              key={entry.name}
              className="grid grid-cols-[minmax(0,140px)_minmax(0,120px)_minmax(0,130px)_minmax(0,1fr)] items-baseline gap-x-3 border-b border-hair py-1.5 text-[11.5px]"
            >
              <span className="truncate font-mono text-fg-mid">
                {entry.name}
              </span>
              <span className="truncate font-mono text-fg-mut">
                {entry.address ?? "—"}
              </span>
              <span className={entry.tls ? "text-ok" : "text-fg-fnt"}>
                {entry.tls ? "TLS" : t("empty", "plainLower")}
              </span>
              <span className="truncate text-fg-mut">
                {entry.redirectTo
                  ? t("empty", "redirectsTo", {
                      target:
                        entry.redirectTo === UNNAMED_TARGET
                          ? t("readings", "traefikAnotherEntryPoint")
                          : entry.redirectTo,
                    })
                  : t("count", "hostsLandHere", { n: landing.length })}
              </span>
            </div>
          );
        })}
      </div>
    </Section>
  );
}

/**
 * The one statement that is about the proxy rather than about a host.
 *
 * A router that names no entry point is bound to every one of them, so a
 * plain entry point with no redirection makes *every* host in the cluster
 * reachable unencrypted — including the ones with a perfectly good
 * certificate. Said once, here, rather than eighty times on the Routes tab.
 */
function PlainEntryPointNote({ controller }: { controller: ControllerInfo }) {
  const t = useT();
  const plain = controller.entryPoints.filter(
    (entry) => !entry.tls && entry.redirectTo === null
  );
  if (plain.length === 0) return null;

  return (
    <p className="max-w-[92ch] border-l-2 border-warn pl-2.5 text-[11.5px] text-fg-mut">
      <span className="text-warn">
        {t("empty", "plainEntryPointsHead", {
          n: plain.length,
          list: plain.map((entry) => entry.name).join(", "),
        })}
      </span>{" "}
      {t("empty", "plainEntryPointsNote")}
    </p>
  );
}

// --- controller ---------------------------------------------------------

function ControllerTab({
  controller,
  sources,
}: {
  controller: ControllerInfo | undefined;
  sources: TraefikSources | null;
}) {
  const t = useT();
  return (
    <ProxyControllerTab
      controller={controller}
      classes={sources ? traefikClasses(sources.classes) : []}
      words={{
        reading: t("empty", "readingTheProxy"),
        title: t("empty", "theProxyTitle"),
        description: t("empty", "theProxyDescription"),
        claimsNoClass: t("empty", "traefikClaimsNoClass"),
      }}
    />
  );
}
