/**
 * Traefik's page: the routing table, pivoted the way the question is asked.
 *
 * ## It opens on Routes, like every page in this tree
 *
 * cert-manager opens on Certificates, Flux on Reconcilers, Argo on
 * Applications, ingress-nginx on its own Routes — every vendor page in this
 * app lands the reader on the list ordered by trouble, because "what is
 * broken" is the question somebody who opened an integration page is almost
 * always asking, and that answer has to be on screen before a click, not
 * behind one. Traefik is not a case for a different rule: Routes carries the
 * same trouble-first ordering, the same auto-opened rows, the same one-line
 * summary at the top. Map is a real screen and stays a click away — it earns
 * that click by answering a different question than triage does — but it is
 * never where the page opens.
 *
 * ## A map and a chain, and they answer different questions
 *
 * A force-directed blob of every route in the cluster is decoration — it
 * looks like insight and answers nothing. One request's journey is not a
 * general graph either; it is a **chain in fixed order**: entry point → rule
 * → middleware → service → pods. So that is drawn as a chain, left to right,
 * with the columns labelled, and only for the host the reader opened.
 *
 * What the chain cannot show is the **shape across hosts** — which entry
 * points carry which hostnames, and which of them land on the same Service —
 * and that is a real question on any cluster with more than one host, which
 * is nearly all of them. It used to have no answer here at all: every host
 * was one collapsed line and the reader had to open them one at a time and
 * hold the picture in their head. Map is that answer, and it is deliberately
 * layered and deterministic rather than force-directed: fixed columns,
 * trouble-first order, no rearranging when a pod restarts. That it exists at
 * all is the whole of its claim on the reader's attention — it does not also
 * need to be the first thing they see.
 *
 * ## Good with one host and with eighty
 *
 * Ordered by trouble, not by name: the reader has one URL that is not
 * working and seventy-nine that are, and the alphabet puts the answer
 * wherever the alphabet happens to put it. A host with a finding opens
 * itself; every other host is one line until it is asked for, so eighty
 * hosts is eighty lines with the three that matter already open. Past
 * {@link AUTO_OPEN} troubled hosts nothing opens itself at all — a screen
 * where everything is expanded is a screen where nothing is emphasised — and
 * the filter above narrows by hostname, service or object name.
 *
 * ## Where a link goes
 *
 * Into this app for everything the cluster owns: the Service, the Ingress,
 * the IngressRoute, the controller's own Deployment and its logs. Traefik's
 * dashboard is good and is deliberately *not* linked to, because this app
 * cannot construct an address for it that works — it is bound to an entry
 * point with no route to it from outside the cluster, and a button that
 * leads to a connection error is worse than no button.
 */

import { useCallback, useMemo } from "react";
import { useServiceRoutes } from "@/hooks/useServiceRoutes";
import { useIngressTls } from "@/hooks/useIngressTls";
import { Link, useSearchParams } from "react-router-dom";
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
  type DetailTabMark,
} from "@/components/resources/detail-tab";
import { useCertificateIssuance } from "@/hooks/useCertificateIssuance";
import { describeStop } from "@/lib/connections";
import type { ChainStop } from "@/generated/types";
import { crdObjectPath, plural } from "../kit";
import {
  Chain,
  Cell,
  Column,
  FilterBox,
  Finding as FindingBlock,
  TroubleRow,
  type Tone,
} from "../page-kit";
import { RoutingMap } from "../routing-map";
import { routingMap } from "./map";
import {
  servedGroupName,
  useBacking,
  useController,
  useRouteCertificates,
  useRouteSources,
  sourcesFrom,
  type ControllerInfo,
} from "./data";
import {
  frontingIngresses,
  allRoutes,
  backingOf,
  boundEntryPoints,
  hostGroups,
  terminatedUpstream,
  middlewareType,
  middlewareUses,
  traefikClasses,
  type Finding,
  type HostGroup,
  type TraefikRoute,
  type TraefikSources,
} from "./model";
import { describePath, fullyRead } from "./rule";

/** Past this many troubled hosts, nothing opens itself. */
const AUTO_OPEN = 8;

export default function TraefikPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") ?? "routes";
  const filter = params.get("q") ?? "";

  // In the URL rather than in a `useState`, so a node on the map can hand the
  // Routes tab a host and land the reader on that host's chain — and so the
  // narrowed view survives a reload and can be handed to somebody else.
  const setFilter = (next: string) => {
    const updated = new URLSearchParams(params);
    if (next.trim() === "") updated.delete("q");
    else updated.set("q", next);
    setParams(updated, { replace: true });
  };

  const routeSources = useRouteSources();
  const backing = useBacking();
  const controller = useController();

  const routes = useMemo(
    () =>
      routeSources.data
        ? allRoutes({
            ...routeSources.data,
            services: [],
            published: [],
            entryPoints: [],
          })
        : [],
    [routeSources.data]
  );
  const certificates = useRouteCertificates(routes);

  // What is in front of the proxy. On a managed cluster the certificate is
  // usually held by a cloud load balancer and named in an annotation, so no
  // amount of reading `spec.tls` finds it — and every host then read as
  // served in the clear. The proxy's own Service is the thing to ask about;
  // asking about the first is enough, because a chart that installs two is
  // installing one proxy behind both.
  const proxy = useMemo(() => {
    const services = backing.data?.services ?? [];
    const found = services.find(
      (service) => service.selector["app.kubernetes.io/name"] === "traefik"
    );
    return found ? { namespace: found.namespace, name: found.name } : null;
  }, [backing.data]);
  // Every Ingress whose backend is the proxy's own Service, which is what a
  // cloud load balancer's Ingress looks like from in here.
  const frontAsked = useMemo(
    () =>
      frontingIngresses({
        ingresses: routeSources.data?.ingresses ?? [],
        services: backing.data?.services ?? [],
      } as never).map(
        (ingress: {
          namespace: string;
          name: string;
          rules: Array<{ host: string }>;
        }) => ({
          namespace: ingress.namespace,
          name: ingress.name,
          hosts: ingress.rules.flatMap((rule: { host: string }) =>
            rule.host ? [rule.host] : []
          ),
        })
      ),
    [routeSources.data, backing.data]
  );

  const fronting = useServiceRoutes(proxy);
  // The certificate may be an ACM ARN or one installed on an Application
  // Gateway, neither of which is a route and neither of which `spec.tls`
  // knows about — so the Ingresses standing in front of the proxy are asked
  // directly. Without this the fix above worked on GKE and nowhere else.
  const front = useIngressTls(frontAsked);
  const frontTls = useCallback(
    (host: string | null) =>
      host !== null &&
      frontAsked.some(
        (ingress) => front.of(ingress, host)?.terminated === true
      ),
    [front, frontAsked]
  );
  const upstreamTls = useCallback(
    (host: string | null) =>
      frontTls(host) ||
      (host !== null &&
        fronting.routes.some(
          (route) => route.tls === true && route.host === host
        )),
    [fronting.routes, frontTls]
  );

  const sources: TraefikSources | null = routeSources.data
    ? {
        ...sourcesFrom(
          routeSources.data,
          backing.data,
          controller.data,
          certificates
        ),
        upstreamTls,
      }
    : null;

  const groups = useMemo(
    () => (sources ? hostGroups(sources) : []),
    // `sources` is rebuilt every render; the inputs it is built from are what
    // actually change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      routeSources.data,
      backing.data,
      controller.data,
      certificates.size,
      upstreamTls,
    ]
  );

  if (routeSources.error) {
    return (
      <Section className="max-w-[64ch] py-8">
        <h2 className="text-[13px] font-semibold tracking-tight text-err">
          Could not read this cluster&rsquo;s routing
        </h2>
        <p className="text-xs text-fg-mut">
          The routes this page draws come from the Ingresses and IngressRoutes
          in this API server, and that request failed — so the table would be a
          guess rather than an answer.
        </p>
        <p className="text-[11px] text-fg-fnt">{routeSources.error.message}</p>
      </Section>
    );
  }

  const uses = sources
    ? middlewareUses(sources.middlewares, allRoutesOf(groups))
    : [];
  const unused = uses.filter((use) => use.usedBy.length === 0).length;
  const troubled = groups.filter((group) => group.worst !== null);

  const tabs: DetailTab[] = [
    {
      id: "routes",
      label: "Routes",
      glyph: viewGlyph(Globe),
      mark: routesMark(groups, troubled.length),
      content: (
        <RoutesTab
          groups={groups}
          sources={sources}
          filter={filter}
          onFilter={setFilter}
          loading={routeSources.isPending}
          backingLoading={backing.isPending}
        />
      ),
    },
    {
      id: "map",
      label: "Map",
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
          ? severityMark("warn", `${plural(unused, "middleware")} unused`)
          : countMark(uses.length),
      content: <MiddlewaresTab uses={uses} />,
    },
    {
      id: "entrypoints",
      label: "Entry points",
      glyph: viewGlyph(Plug),
      mark:
        controller.data && controller.data.entryPoints.length > 0
          ? countMark(controller.data.entryPoints.length)
          : undefined,
      content: <EntryPointsTab controller={controller.data} groups={groups} />,
    },
    {
      id: "controller",
      label: "Controller",
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
            : `${plural(groups.length, "host")} across every namespace`
        }
        description="What this proxy serves, and where each hostname goes."
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

function allRoutesOf(groups: HostGroup[]): TraefikRoute[] {
  return groups.flatMap((group) => group.routes);
}

/**
 * A count is inventory and a colour is why you came, so the strip never
 * carries both: a routing table with three broken hosts says three broken
 * hosts, not six.
 */
function routesMark(
  groups: HostGroup[],
  troubled: number
): DetailTabMark | undefined {
  if (groups.length === 0) return undefined;
  const worst = groups.some((group) => group.worst === "err") ? "err" : "warn";
  return troubled > 0
    ? severityMark(
        worst,
        `${troubled} of ${groups.length} hosts need attention`
      )
    : countMark(groups.length);
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
  const data = useMemo(
    () => (sources ? routingMap(groups, sources) : null),
    [groups, sources]
  );

  if (loading) {
    return <p className="text-xs text-fg-fnt">Reading the routing table…</p>;
  }
  if (!data || groups.length === 0) return <NothingRoutes />;

  const broken = groups.filter((group) => group.worst === "err").length;
  const worthALook = groups.filter((group) => group.worst === "warn").length;

  return (
    <div className="flex flex-col gap-2">
      <p className="text-[11px] text-fg-fnt">
        {broken > 0
          ? `${broken} of ${groups.length} hosts broken${worthALook > 0 ? ` · ${worthALook} worth a look` : ""}`
          : worthALook > 0
            ? `nothing broken · ${worthALook} of ${groups.length} worth a look`
            : `${plural(groups.length, "host")}, none with a problem`}
        {backingLoading && " · checking what is behind them…"}
      </p>
      <RoutingMap data={data} />
      <p className="text-[11px] text-fg-fnt">
        A host goes to its own paths and their chain; a Service goes to its
        page. Nothing here is inferred — every line is one object naming
        another.
      </p>
    </div>
  );
}

/** The one thing both the map and the list say when there is no routing. */
function NothingRoutes() {
  return (
    <div className="max-w-[64ch]">
      <p className="text-xs text-fg-mut">
        Traefik is running here and nothing routes to it.
      </p>
      <p className="mt-1.5 text-[11px] text-fg-fnt">
        No IngressRoute exists, and no Ingress names an IngressClass this proxy
        claims. An Ingress naming a class nothing serves is correct YAML with no
        events and no error, and is simply never served.
      </p>
    </div>
  );
}

// --- routes -------------------------------------------------------------

function RoutesTab({
  groups,
  sources,
  filter,
  onFilter,
  loading,
  backingLoading,
}: {
  groups: HostGroup[];
  sources: TraefikSources | null;
  filter: string;
  onFilter: (value: string) => void;
  loading: boolean;
  backingLoading: boolean;
}) {
  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (needle === "") return groups;
    return groups.filter(
      (group) =>
        (group.host ?? "").toLowerCase().includes(needle) ||
        group.routes.some(
          (route) =>
            route.source.name.toLowerCase().includes(needle) ||
            route.source.namespace.toLowerCase().includes(needle) ||
            (route.service?.name ?? route.resourceBackend ?? "")
              .toLowerCase()
              .includes(needle)
        )
    );
  }, [groups, filter]);

  if (loading) {
    return <p className="text-xs text-fg-fnt">Reading the routing table…</p>;
  }

  if (groups.length === 0) return <NothingRoutes />;

  const broken = groups.filter((group) => group.worst === "err").length;
  const worthALook = groups.filter((group) => group.worst === "warn").length;

  return (
    <div className="flex flex-col">
      <div className="mb-1 flex items-center gap-3">
        <FilterBox
          value={filter}
          onChange={onFilter}
          placeholder="Filter by host, service or object"
          label="Filter hosts"
        />
        <span className="text-[11px] text-fg-fnt">
          {filter.trim() !== ""
            ? `${shown.length} of ${groups.length}`
            : broken > 0
              ? `${broken} of ${groups.length} broken, and first${worthALook > 0 ? ` · ${worthALook} worth a look` : ""}`
              : worthALook > 0
                ? `nothing broken · ${worthALook} of ${groups.length} worth a look`
                : `${plural(groups.length, "host")}, none with a problem`}
        </span>
        {backingLoading && (
          <span className="text-[11px] text-fg-fnt">
            checking what is behind them…
          </span>
        )}
      </div>
      {shown.length === 0 ? (
        <p className="py-6 text-xs text-fg-fnt">
          No host, service or object here matches that.
        </p>
      ) : (
        shown.map((group, index) => (
          <HostRow
            key={group.host ?? `catch-all-${index}`}
            group={group}
            sources={sources}
            // Only an outage opens itself, and only while there are few
            // enough of them to read: a screen where everything is expanded
            // is a screen where nothing is emphasised.
            openByDefault={group.worst === "err" && broken <= AUTO_OPEN}
          />
        ))
      )}
    </div>
  );
}

/** The word at the right of a host line: what is true of it right now. */
function hostState(group: HostGroup): { text: string; tone: Tone } {
  const stop = group.findings.find((finding) => finding.kind === "stop");
  if (stop) return { text: "nothing behind it", tone: "err" };
  const certificate = group.findings.find(
    (finding) => finding.kind === "certificate" && finding.severity === "err"
  );
  if (certificate) {
    return {
      text:
        certificate.kind === "certificate" && certificate.expiry?.expired
          ? "certificate expired"
          : "certificate running out",
      tone: "err",
    };
  }
  if (group.findings.some((finding) => finding.kind === "clear")) {
    return { text: "served in the clear", tone: "warn" };
  }
  if (group.findings.length > 0) {
    return { text: "worth a look", tone: "warn" };
  }
  return { text: "serving", tone: "ok" };
}

function HostRow({
  group,
  sources,
  openByDefault,
}: {
  group: HostGroup;
  sources: TraefikSources | null;
  openByDefault: boolean;
}) {
  const state = hostState(group);
  const tls = group.tlsSecrets[0];
  // Where the certificate is, when it is not here. Stated rather than merely
  // not warned about: a reader who knows TLS ends at the load balancer learns
  // nothing from silence, and a reader who does not is the one this line is
  // for. `null` on every ordinary cluster, where the proxy holds its own.
  const upstream =
    sources && !tls ? terminatedUpstream(group.host, sources) : null;
  const upstreamNamed =
    upstream ?? (sources?.upstreamTls?.(group.host) ? "the edge" : null);
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
      title={group.host ?? "any host"}
      copy={group.host ?? undefined}
      meta={
        <>
          {plural(group.routes.length, "path")}
          {entryPoints.length > 0 &&
            ` · ${everywhere ? "every entry point" : summarise(entryPoints)}`}
          {tls
            ? ` · TLS from ${tls.secretName}`
            : upstreamNamed
              ? ` · TLS ends at ${typeof upstreamNamed === "string" ? upstreamNamed : upstreamNamed.name}`
              : " · no TLS"}
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
      <Paths group={group} sources={sources} />
      {sources && <HostChain group={group} sources={sources} />}
      <Findings group={group} />
    </TroubleRow>
  );
}

/** Three names and a tally: a row is a summary, not the whole list. */
function summarise(names: string[]): string {
  if (names.length <= 3) return names.join(", ");
  return `${names.slice(0, 3).join(", ")} +${names.length - 3}`;
}

function Paths({
  group,
  sources,
}: {
  group: HostGroup;
  sources: TraefikSources | null;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      {group.routes.map((route) => (
        <PathRow key={route.key} route={route} sources={sources} />
      ))}
    </div>
  );
}

function PathRow({
  route,
  sources,
}: {
  route: TraefikRoute;
  sources: TraefikSources | null;
}) {
  const backing = sources ? backingOf(route, sources) : null;

  return (
    <div className="grid grid-cols-[minmax(0,190px)_minmax(0,1fr)_auto] items-baseline gap-x-3 text-[11.5px] text-fg-mut">
      <span className="truncate font-mono text-fg-mid">
        {describePath(route.clause.path)}
        {route.pathType && route.pathType !== "Prefix" && (
          <span className="ml-1 text-fg-fnt">{route.pathType}</span>
        )}
      </span>
      <span className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
        {route.middlewares.length > 0 && (
          <>
            <span className="text-fg-fnt">through</span>
            <span className="font-mono text-fg-mid">
              {route.middlewares.map((m) => m.name).join(" → ")}
            </span>
          </>
        )}
        <span className="text-fg-fnt">to</span>
        {route.service ? (
          <>
            {route.service.kubernetes ? (
              <ResourceRef
                kind="Service"
                name={route.service.name}
                namespace={route.service.namespace}
                showKind={false}
              />
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
          <span className="text-err">no service</span>
        )}
        <SourceRef route={route} />
      </span>
      <span className="text-[11px] text-fg-fnt">
        {route.resourceBackend
          ? "an API object"
          : !route.service?.kubernetes
            ? "inside the proxy"
            : backing && !backing.known
              ? "…"
              : backing?.stop
                ? "—"
                : backing
                  ? `${backing.ready} ready`
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
  const route = group.chainFor;
  const backing = backingOf(route, sources);
  const entryPoints = boundEntryPoints(route, sources.entryPoints);
  const tls = route.tlsSecret;

  return (
    <div className="flex flex-col gap-1">
      {group.routes.length > 1 && (
        <span className="text-[10px] text-fg-fnt">
          the path through {describePath(route.clause.path)}
        </span>
      )}
      <Chain>
        <Column label="Entry point">
          {entryPoints.length === 0 ? (
            <Cell under="not read">unknown</Cell>
          ) : route.entryPoints === null ? (
            // The object names none, which in Traefik means all of them.
            // Stacking four cells to say so makes the chain taller than the
            // answer is worth.
            <Cell under={entryPoints.map((entry) => entry.name).join(", ")}>
              every entry point
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
        <Column label="Rule">
          <Cell
            under={
              route.rule.raw === null
                ? `${route.source.kind} rule`
                : fullyRead(route.rule)
                  ? undefined
                  : "shown in full below"
            }
          >
            {group.host ?? "any host"}
            {route.clause.path ? ` ${describePath(route.clause.path)}` : ""}
          </Cell>
        </Column>
        <Column label="Middleware">
          {route.middlewares.length === 0 ? (
            <div className="rounded-[4px] border border-hair px-2 py-1 font-mono text-[11px] text-fg-fnt opacity-60">
              none
            </div>
          ) : (
            route.middlewares.map((middleware) => (
              <Cell
                key={`${middleware.namespace}/${middleware.name}`}
                under={middlewareDetail(
                  sources,
                  middleware.name,
                  middleware.namespace
                )}
              >
                {middleware.name}
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
                  : "Traefik's own, not a Service"
              }
            >
              {route.service.name}
            </Cell>
          ) : route.resourceBackend ? (
            // An API object, not a Service. It has no endpoints by design
            // and the app cannot see inside it, so nothing is claimed.
            <Cell under="an API object, not a Service">
              {route.resourceBackend}
            </Cell>
          ) : (
            <Cell bad>none</Cell>
          )}
        </Column>
        <Column label="Published">
          {route.resourceBackend ? (
            <Cell under="not a Service">—</Cell>
          ) : !route.service?.kubernetes ? (
            <Cell under="inside the proxy">not pods</Cell>
          ) : !backing.known ? (
            <Cell under="reading endpoints">—</Cell>
          ) : backing.stop ? (
            <Cell bad under={STOP_UNDER[backing.stop.reason]}>
              0 published
            </Cell>
          ) : (
            <Cell
              // A draining address is still the one traffic goes to, so the
              // column says so instead of counting it as an outage.
              warn={backing.ready === 0 && backing.draining > 0}
              under={
                backing.draining > 0
                  ? `${backing.draining} draining`
                  : backing.notReady > 0
                    ? `${backing.notReady} not ready`
                    : `of ${backing.ready}`
              }
            >
              {backing.ready + backing.draining} published
            </Cell>
          )}
        </Column>
      </Chain>
      {tls && (
        <span className="text-[11px] text-fg-fnt">
          served under{" "}
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
  const { rule } = route;
  return (
    <div className="mt-1 border-l-2 border-hair pl-2.5">
      <p className="text-[11px] text-fg-mut">
        {rule.refused
          ? `This rule is shown exactly as written, because ${rule.refused}.`
          : `Shown exactly as written: ${rule.unread.join(", ")} ${
              rule.unread.length === 1 ? "is" : "are"
            } not interpreted here.`}
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
  namespace: string
): string | undefined {
  const found = sources.middlewares.find(
    (middleware) =>
      middleware.name === name && (middleware.namespace ?? "") === namespace
  );
  if (!found) return "not found in this cluster";
  return middlewareType(found) ?? undefined;
}

// --- findings -----------------------------------------------------------

function Findings({ group, brief }: { group: HostGroup; brief?: boolean }) {
  const issuance = useCertificateIssuance(
    group.tlsSecrets[0]?.namespace,
    group.tlsSecrets.map((secret) => secret.secretName)
  );

  if (group.findings.length === 0) return null;

  // A closed row already carries its state in the word at its right end, and
  // "served in the clear" under a row that says `served in the clear` is the
  // same sentence twice and twice the height. Only a finding that says more
  // than the status word does earns a line on a closed row — which on a
  // cluster of eighty plain-HTTP hosts is the difference between eighty rows
  // and a hundred and sixty.
  const worthRepeating = group.findings.filter(
    (finding) => finding.kind !== "clear"
  );
  if (brief && worthRepeating.length === 0) return null;
  const shown = brief ? worthRepeating.slice(0, 1) : group.findings;
  const hidden = brief ? worthRepeating.length - 1 : 0;

  return (
    <div className="flex flex-col gap-2">
      {shown.map((finding, index) => (
        <FindingLine
          key={index}
          finding={finding}
          brief={brief}
          issuance={issuance}
        />
      ))}
      {hidden > 0 && (
        <span className="text-[11px] text-fg-fnt">
          and {hidden} more — open the row
        </span>
      )}
    </div>
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
  const said = describeFinding(finding);
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

/** What a stopped path says in the column, in four words or fewer. */
const STOP_UNDER: Record<ChainStop["reason"], string> = {
  backendMissing: "no service to send to",
  selectsNothing: "selector matches nothing",
  noneReady: "running, none ready",
  publishesNothing: "no port to send to",
};

function describeFinding(finding: Finding): { title: string; note: string } {
  switch (finding.kind) {
    case "stop": {
      // The same three sentences the traffic chain uses, so "no pod carries
      // app=promo" reads identically whether it was reached from a
      // Deployment or from a hostname.
      const said = describeStop(finding.stop);
      return {
        title: `This host answers, and every request gets a 502 — ${said.title.charAt(0).toLowerCase()}${said.title.slice(1)}`,
        note: said.note,
      };
    }
    case "clear":
      return {
        title: "Served in the clear — nothing offers this host over TLS",
        note: `No route under this host carries a certificate, and it is bound to ${finding.entryPoints.join(
          ", "
        )}, which ${
          finding.entryPoints.length === 1 ? "terminates" : "terminate"
        } no TLS and ${
          finding.entryPoints.length === 1 ? "carries" : "carry"
        } no redirection. There is no encrypted way to reach it, even for a client that asks for one.`,
      };
    case "duplicate":
      return {
        title: `Two objects claim ${finding.path} on this host`,
        note: finding.winner
          ? `${describeRouteSource(finding.winner)} wins: it declares the higher priority. The other never fires.`
          : `${finding.routes.map(describeRouteSource).join(" and ")} both match it. Traefik breaks the tie by router priority, and neither object states one — the default is the length of the rule Traefik itself generated, which this app never sees, so which of them serves the request is not something these objects settle.`,
      };
    case "certificate": {
      if (!finding.expiry) {
        return {
          title: `${finding.secretName} could not be read as a certificate`,
          note:
            finding.read?.problem ??
            "The Secret is there and what is in it is not a certificate this app could parse.",
        };
      }
      return {
        title: `${finding.secretName} ${finding.expiry.text}`,
        note: "Requests to this host fail closed in every browser once it goes, and nothing on the Ingress or the Service says so.",
      };
    }
  }
}

function describeRouteSource(route: TraefikRoute): string {
  return `${route.source.kind} ${route.source.namespace}/${route.source.name}`;
}

// --- middlewares --------------------------------------------------------

function MiddlewaresTab({ uses }: { uses: ReturnType<typeof middlewareUses> }) {
  if (uses.length === 0) {
    return (
      <p className="max-w-[64ch] text-xs text-fg-mut">
        This cluster has no Middleware objects. Traefik serves every route
        without one, which is the ordinary case.
      </p>
    );
  }

  return (
    <Section>
      <SectionHeader
        title="Middlewares"
        count={uses.length}
        description="Every one, and who uses it. A middleware nothing references is doing nothing, and nowhere else in this app could tell you."
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
                nothing references it — it is configuration that does nothing
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
  if (!controller) {
    return <p className="text-xs text-fg-fnt">Reading the proxy…</p>;
  }
  if (controller.entryPoints.length === 0) {
    return (
      <div className="max-w-[64ch]">
        <p className="text-xs text-fg-mut">
          This cluster cannot say what Traefik listens on.
        </p>
        <p className="mt-1.5 text-[11px] text-fg-fnt">
          {controller.problem ??
            "Entry points are static configuration — they exist only in the flags the proxy was started with, and nothing in the API server carries them."}
        </p>
      </div>
    );
  }

  return (
    <Section>
      <SectionHeader
        title="Entry points"
        count={controller.entryPoints.length}
        description="What the proxy listens on, which of them terminate TLS, and which hosts land on each — the answer to “why is my route on :80”."
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
                {entry.tls ? "TLS" : "plain"}
              </span>
              <span className="truncate text-fg-mut">
                {entry.redirectTo
                  ? `redirects to ${entry.redirectTo}`
                  : `${plural(landing.length, "host")} land here`}
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
  const plain = controller.entryPoints.filter(
    (entry) => !entry.tls && entry.redirectTo === null
  );
  if (plain.length === 0) return null;

  return (
    <p className="max-w-[92ch] border-l-2 border-warn pl-2.5 text-[11.5px] text-fg-mut">
      <span className="text-warn">
        {plain.map((entry) => entry.name).join(", ")}{" "}
        {plain.length === 1 ? "terminates" : "terminate"} no TLS and{" "}
        {plain.length === 1 ? "redirects" : "redirect"} nowhere.
      </span>{" "}
      A route that names no entry point is bound to all of them, so every host
      in this cluster is also reachable unencrypted — including the ones with a
      certificate. Setting a redirection on the entry point fixes all of them at
      once; a redirect middleware fixes one route.
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
  if (!controller) {
    return <p className="text-xs text-fg-fnt">Reading the proxy…</p>;
  }
  const classes = sources ? traefikClasses(sources.classes) : [];

  return (
    <div className="flex flex-col gap-[22px]">
      <Section>
        <SectionHeader
          title="The proxy"
          description="Where a Traefik problem is actually diagnosed: its own pods, and its own logs."
        />
        {controller.workload ? (
          <div className="flex flex-col gap-1 text-[11.5px] text-fg-mut">
            <span className="flex flex-wrap items-baseline gap-x-2">
              <ResourceRef
                kind={controller.workload.kind}
                name={controller.workload.name}
                namespace={controller.workload.namespace}
                showKind={false}
              />
              <span className="text-fg-fnt">
                {controller.workload.ready} of {controller.workload.desired}{" "}
                ready · {controller.workload.namespace}
              </span>
            </span>
            {controller.workload.image && (
              <span className="font-mono text-[11px] text-fg-fnt">
                {controller.workload.image}
              </span>
            )}
            {controller.problem && (
              <p className="text-[11px] text-warn">{controller.problem}</p>
            )}
          </div>
        ) : (
          <p className="max-w-[64ch] text-[11px] text-fg-fnt">
            {controller.problem}
          </p>
        )}
      </Section>

      <Section>
        <SectionHeader
          title="Classes it claims"
          count={classes.length}
          description="An Ingress naming a class nothing claims is correct YAML with no events and no error, and is simply never served."
        />
        {classes.length === 0 ? (
          <p className="text-[11px] text-warn">
            Traefik is running and claims no IngressClass, so no Ingress in this
            cluster can reach it by class.
          </p>
        ) : (
          <div className="flex flex-col">
            {classes.map((entry) => (
              <div
                key={entry.name}
                className="flex items-baseline gap-2 border-b border-hair py-1.5 text-[11.5px]"
              >
                <span className="font-mono text-fg-mid">{entry.name}</span>
                {entry.isDefault && (
                  <span className="text-[11px] text-fg-fnt">
                    this cluster&rsquo;s default
                  </span>
                )}
                <span className="ml-auto font-mono text-[11px] text-fg-fnt">
                  {entry.controller}
                </span>
              </div>
            ))}
          </div>
        )}
      </Section>

      {controller.args.length > 0 && (
        <Section>
          <SectionHeader
            title="Static configuration"
            count={controller.args.length}
            description="The flags the process was started with. Nothing in the API server carries these, which is why they are read from the workload itself."
          />
          <div className="flex flex-col gap-0.5 font-mono text-[11px] text-fg-mut">
            {controller.args.map((arg, index) => (
              <span key={index} className="select-text break-all">
                {arg}
              </span>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}
