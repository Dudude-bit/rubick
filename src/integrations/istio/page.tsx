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
import { Link, useSearchParams } from "react-router-dom";
import { DoorOpen, Split, Waypoints } from "lucide-react";

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
import type { ChainStop, CustomResourceInfo } from "@/generated/types";
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

const AUTO_OPEN = 8;

export default function IstioPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") ?? "routes";

  const mesh = useMesh();
  const backing = useBacking();

  const sources: IstioSources | null = mesh.data
    ? sourcesFrom(mesh.data, backing.data)
    : null;

  const groups = useMemo(
    () => (sources ? hostGroups(sources) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mesh.data, backing.data]
  );

  if (mesh.error) {
    return (
      <Section className="max-w-[64ch] py-8">
        <h2 className="text-[13px] font-semibold tracking-tight text-err">
          Could not read this mesh&rsquo;s routing
        </h2>
        <p className="text-xs text-fg-mut">
          Every route this page draws is a Gateway, a VirtualService or a
          DestinationRule in this API server, and that request failed — so the
          chain would be a guess rather than an answer.
        </p>
        <p className="text-[11px] text-fg-fnt">{mesh.error.message}</p>
      </Section>
    );
  }

  const troubled = groups.filter((group) => group.worst !== null);

  const tabs: DetailTab[] = [
    {
      id: "routes",
      label: "Routes",
      glyph: viewGlyph(Waypoints),
      mark: routesMark(groups, troubled.length),
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
      label: "Subsets",
      glyph: viewGlyph(Split),
      mark: subsetsMark(groups),
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
            : `${plural(groups.length, "host")} across every namespace`
        }
        description="What this mesh routes, and where each hostname stops."
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

function subsetsMark(groups: IstioHostGroup[]): DetailTabMark | undefined {
  const missing = groups.flatMap((group) =>
    group.findings.filter((finding) => finding.kind === "noSubset")
  ).length;
  return missing > 0
    ? severityMark(
        "err",
        `${plural(missing, "route")} to a subset nothing defines`
      )
    : undefined;
}

// --- routes -------------------------------------------------------------

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
    return <p className="text-xs text-fg-fnt">Reading the mesh…</p>;
  }

  if (groups.length === 0) {
    return (
      <div className="max-w-[64ch]">
        <p className="text-xs text-fg-mut">
          Istio is installed here and nothing routes through it.
        </p>
        <p className="mt-1.5 text-[11px] text-fg-fnt">
          No VirtualService declares a host. The mesh will still carry traffic
          between the workloads that have a sidecar — that is the default and
          needs no object — but there is no routing rule to draw.
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
          placeholder="Filter by host, VirtualService or destination"
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
          No host, VirtualService or destination here matches that.
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

function hostState(group: IstioHostGroup): { text: string; tone: Tone } {
  if (group.findings.some((finding) => finding.kind === "noGateway")) {
    return { text: "no Gateway serves it", tone: "err" };
  }
  if (group.findings.some((finding) => finding.kind === "noSubset")) {
    return { text: "subset not defined", tone: "err" };
  }
  if (group.findings.some((finding) => finding.kind === "stop")) {
    return { text: "nothing behind it", tone: "err" };
  }
  if (group.findings.some((finding) => finding.kind === "weights")) {
    return { text: "weights do not add up", tone: "warn" };
  }
  if (group.findings.length > 0) return { text: "worth a look", tone: "warn" };
  return { text: "routing", tone: "ok" };
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
  const serving = group.gateways.filter((gateway) => gateway.serves);

  return (
    <TroubleRow
      title={group.host}
      meta={
        <>
          {plural(group.routes.length, "rule")}
          {group.meshOnly
            ? " · in-mesh only"
            : serving.length > 0
              ? ` · through ${serving.map((gateway) => gateway.named).join(", ")}`
              : ` · ${plural(group.gateways.length, "gateway")} named`}
        </>
      }
      state={hostState(group)}
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
  return (
    <div className="grid grid-cols-[minmax(0,260px)_minmax(0,1fr)] items-baseline gap-x-3 text-[11.5px] text-fg-mut">
      <span className="truncate font-mono text-fg-mid">
        {route.matches.length === 0
          ? "every request"
          : route.matches.map(describeMatch).join(" or ")}
        {route.protocol !== "http" && (
          <span className="ml-1 text-fg-fnt">{route.protocol}</span>
        )}
      </span>
      <span className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
        <span className="text-fg-fnt">to</span>
        {route.destinations.length === 0 ? (
          <span className="text-err">nowhere</span>
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
          <Link
            to={crdObjectPath(
              KINDS.virtualServices,
              route.source.namespace,
              route.source.name
            )}
            className="font-mono text-info hover:underline"
          >
            {route.source.name}
          </Link>
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
          the rule for{" "}
          {route.matches.length === 0
            ? "every request"
            : describeMatch(route.matches[0])}
        </span>
      )}
      <Chain>
        <Column label="Gateway">
          {group.meshOnly ? (
            <Cell under="no edge listener">in-mesh only</Cell>
          ) : group.gateways.length === 0 ? (
            <Cell bad under="named none">
              none
            </Cell>
          ) : serving.length === 0 ? (
            <Cell
              bad
              under={
                group.gateways.some((gateway) => gateway.gateway === null)
                  ? "not in this cluster"
                  : "serves other hosts"
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
                ? "every request"
                : unread.length > 0
                  ? "shown in full below"
                  : describeMatch(route.matches[0])
            }
          >
            {route.source.name}
          </Cell>
        </Column>
        <Column label="DestinationRule">
          {!destination?.subset ? (
            <div className="rounded-[4px] border border-hair px-2 py-1 font-mono text-[11px] text-fg-fnt opacity-60">
              no subset
            </div>
          ) : (
            <Cell
              bad={!subsets.defined.includes(destination.subset)}
              under={
                subsets.defined.includes(destination.subset)
                  ? `of ${subsets.defined.join(", ")}`
                  : subsets.anyRule
                    ? `defines ${subsets.defined.join(", ") || "no subsets"}`
                    : "no rule names this host"
              }
            >
              {destination.subset}
            </Cell>
          )}
        </Column>
        <Column label="Service">
          {!destination ? (
            <Cell bad>none</Cell>
          ) : destination.external ? (
            <Cell under="outside this cluster">{destination.host}</Cell>
          ) : (
            <Cell
              bad={backing?.stop?.reason === "backendMissing"}
              under={`${destination.port ? `:${destination.port} · ` : ""}${destination.service?.namespace}`}
            >
              {destination.service?.name}
            </Cell>
          )}
        </Column>
        <Column label="Published">
          {!destination || destination.external ? (
            <Cell under="not this cluster's pods">—</Cell>
          ) : !backing?.known ? (
            <Cell under="reading endpoints">—</Cell>
          ) : backing.stop ? (
            <Cell bad under={STOP_UNDER[backing.stop.reason]}>
              0 published
            </Cell>
          ) : (
            <Cell
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
  return (
    <div className="mt-1 flex flex-col gap-1.5">
      {matches.map((match, index) => (
        <div key={index} className="border-l-2 border-hair pl-2.5">
          <p className="text-[11px] text-fg-mut">
            {match.refused
              ? `This match is shown exactly as written, because ${match.refused}.`
              : `Shown exactly as written: ${match.unread
                  .map((line) => line.split(":")[0])
                  .join(", ")} ${
                  match.unread.length === 1 ? "is" : "are"
                } not interpreted here.`}
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

const STOP_UNDER: Record<ChainStop["reason"], string> = {
  backendMissing: "no service to send to",
  selectsNothing: "selector matches nothing",
  noneReady: "running, none ready",
  publishesNothing: "no port to send to",
};

function Findings({
  group,
  brief,
}: {
  group: IstioHostGroup;
  brief?: boolean;
}) {
  if (group.findings.length === 0) return null;
  const shown = brief ? group.findings.slice(0, 1) : group.findings;
  const hidden = brief ? group.findings.length - 1 : 0;

  return (
    <div className="flex flex-col gap-2">
      {shown.map((finding, index) => {
        const said = describeFinding(finding);
        return (
          <FindingBlock key={index} tone={finding.severity} title={said.title}>
            {!brief && said.note}
          </FindingBlock>
        );
      })}
      {hidden > 0 && (
        <span className="text-[11px] text-fg-fnt">
          and {hidden} more — open the row
        </span>
      )}
    </div>
  );
}

function describeFinding(finding: Finding): { title: string; note: string } {
  switch (finding.kind) {
    case "noGateway": {
      const missing = finding.gateways.filter(
        (gateway) => gateway.gateway === null
      );
      return {
        title: `No Gateway serves ${finding.host}`,
        note:
          missing.length > 0
            ? `${missing
                .map((gateway) => gateway.named)
                .join(
                  ", "
                )} ${missing.length === 1 ? "is" : "are"} named here and ${missing.length === 1 ? "does" : "do"} not exist in this cluster. Istio accepts the reference without complaint and the VirtualService receives nothing at the edge — there is no status, no event and no condition anywhere that says so.`
            : `${finding.gateways
                .map((gateway) => gateway.named)
                .join(
                  ", "
                )} exist${finding.gateways.length === 1 ? "s" : ""} and no server on ${finding.gateways.length === 1 ? "it" : "them"} covers this hostname, so nothing at the edge is listening for it. The VirtualService is correct YAML that receives no request.`,
      };
    }
    case "noSubset":
      return {
        title: `${finding.route.source.name} routes to a subset called ${finding.destination.subset}, and nothing defines it`,
        note: finding.anyRule
          ? `A DestinationRule names ${finding.destination.host} and declares ${
              finding.defined.length > 0
                ? `${finding.defined.join(", ")} — not ${finding.destination.subset}`
                : "no subsets at all"
            }. Istio has no endpoints to send this route to, and every request on it is answered with a 503.`
          : `No DestinationRule in this cluster names ${finding.destination.host} at all, so the subset ${finding.destination.subset} is defined nowhere. A subset is a label selector that has to exist before it can be routed to; every request on this route gets a 503.`,
      };
    case "weights": {
      return {
        title: `The weights on this rule add up to ${finding.sum}, not 100`,
        note: `Istio divides a route's traffic by a hundred, so ${
          finding.sum < 100
            ? `${100 - finding.sum}% of the requests matching this rule are not covered by any destination it names`
            : "the shares written here are not the shares that will be served"
        }. The proportion actually served is not something these objects state.`,
      };
    }
    case "stop": {
      const said = describeStop(finding.stop);
      return {
        title: `This route resolves and every request gets a 503 — ${said.title.charAt(0).toLowerCase()}${said.title.slice(1)}`,
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
  if (loading) return <p className="text-xs text-fg-fnt">Reading the mesh…</p>;
  if (gateways.length === 0) {
    return (
      <p className="max-w-[64ch] text-xs text-fg-mut">
        This cluster has no Gateway objects, so nothing in the mesh is exposed
        at the edge. Traffic between workloads that have a sidecar still flows,
        which needs no Gateway.
      </p>
    );
  }

  return (
    <Section>
      <SectionHeader
        title="Gateways"
        count={gateways.length}
        description="What the mesh listens on at its edge, and which hosts bind to each. A Gateway nothing binds to is a listener with no routes behind it."
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
              <Link
                to={crdObjectPath(
                  KINDS.gateways,
                  gateway.namespace,
                  gateway.name
                )}
                className="truncate font-mono text-info hover:underline"
              >
                {gateway.name}
              </Link>
              <span className="truncate font-mono text-fg-mut">
                {servers
                  .map(
                    (server) =>
                      `${server.port?.protocol ?? "?"}:${server.port?.number ?? "?"} → ${
                        server.hosts?.join(", ") ?? "*"
                      }`
                  )
                  .join(" · ") || "no servers"}
              </span>
              {bound.length === 0 ? (
                <span className="text-warn">
                  {named.length > 0
                    ? `${plural(named.length, "host")} names it, none covered`
                    : "nothing binds to it"}
                </span>
              ) : (
                <span className="truncate text-fg-mut">
                  {plural(bound.length, "host")}
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
  if (loading) return <p className="text-xs text-fg-fnt">Reading the mesh…</p>;
  if (rules.length === 0) {
    return (
      <p className="max-w-[64ch] text-xs text-fg-mut">
        This cluster has no DestinationRule objects. Every route reaches its
        Service&rsquo;s pods with no subset in between, which is the ordinary
        case.
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
            title="Routed to, and defined nowhere"
            count={missing.length}
            description="A subset is a label selector that has to exist before a route can name it. Istio accepts the reference and answers every request on that route with a 503."
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
          title="Subsets"
          count={rules.length}
          description="Every DestinationRule, the subsets it defines, and whether anything routes to them."
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
                <Link
                  to={crdObjectPath(
                    KINDS.destinationRules,
                    rule.namespace,
                    rule.name
                  )}
                  className="truncate font-mono text-info hover:underline"
                >
                  {rule.name}
                </Link>
                <span className="truncate font-mono text-fg-mut">
                  {spec.host ?? "—"}
                </span>
                <span className="truncate text-fg-mut">
                  {subsets.length === 0 ? (
                    <span className="text-fg-fnt">
                      no subsets — traffic policy only
                    </span>
                  ) : unused.length === subsets.length ? (
                    <span className="text-warn">
                      {subsets.join(", ")} — nothing routes to{" "}
                      {subsets.length === 1 ? "it" : "them"}
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
            reading what is behind them…
          </p>
        )}
      </Section>
    </div>
  );
}
