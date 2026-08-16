/**
 * ingress-nginx's page: the same host pivot, and the behaviour nobody can see.
 *
 * The pivot is Traefik's, deliberately and without apology — it is the same
 * question, so it is the same drawing: hosts ordered by trouble, one line
 * until asked, and a chain in fixed order drawn left to right for the host
 * the reader opened. What differs is the middle column. Traefik's middleware
 * is an object with a name; nginx's is a set of annotation keys on the
 * Ingress itself, and the whole reason this page exists is that a wall of
 * `nginx.ingress.kubernetes.io/*` strings is a program the reader has to
 * already know how to run.
 *
 * Every decoded line keeps its raw key. Nobody has to trust the paraphrase,
 * and where there is no paraphrase — a key not in the table, a value the
 * table cannot read, and always a snippet — the line says so in the app's
 * own voice rather than going quiet.
 */

import { useCallback, useMemo, useState } from "react";
import { useServiceRoutes } from "@/hooks/useServiceRoutes";
import { useIngressTls } from "@/hooks/useIngressTls";
import { Box, FileCode2, Globe, SlidersHorizontal } from "lucide-react";

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
import { useSearchParams } from "react-router-dom";
import type { ChainStop } from "@/generated/types";
import { plural } from "../kit";
import {
  Chain,
  Cell,
  Column,
  FilterBox,
  Finding as FindingBlock,
  TroubleRow,
  type Tone,
} from "../page-kit";
import { RAW_NOTE, type AnnotationReading } from "./annotations";
import { readSettings, type SettingReading } from "./configmap";
import {
  sourcesFrom,
  useBacking,
  useController,
  useRouteCertificates,
  useRouteSources,
  type ControllerInfo,
} from "./data";
import {
  frontingIngresses,
  allRoutes,
  backingOf,
  hostGroups,
  nginxClasses,
  type Finding,
  type NginxHostGroup,
  type NginxRoute,
  type NginxSources,
} from "./model";

/** Past this many troubled hosts, nothing opens itself. */
const AUTO_OPEN = 8;

export default function IngressNginxPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") ?? "routes";

  const routeSources = useRouteSources();
  const backing = useBacking();
  const controller = useController();

  const routes = useMemo(
    () =>
      routeSources.data
        ? allRoutes({ ...routeSources.data, services: [], published: [] })
        : [],
    [routeSources.data]
  );
  const certificates = useRouteCertificates(routes);

  // What is in front of nginx. The certificate is usually held by a cloud
  // load balancer and named in an annotation, so `spec.tls` never sees it and
  // every host read as served in the clear.
  const proxy = useMemo(() => {
    const found = (backing.data?.services ?? []).find(
      (service) =>
        service.selector["app.kubernetes.io/name"] === "ingress-nginx"
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

  const sources: NginxSources | null = routeSources.data
    ? {
        ...sourcesFrom(routeSources.data, backing.data, certificates),
        upstreamTls,
      }
    : null;

  const groups = useMemo(
    () => (sources ? hostGroups(sources) : []),
    // `sources` is rebuilt every render; the inputs it is built from are what
    // actually change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [routeSources.data, backing.data, certificates.size, upstreamTls]
  );

  if (routeSources.error) {
    return (
      <Section className="max-w-[64ch] py-8">
        <h2 className="text-[13px] font-semibold tracking-tight text-err">
          Could not read this cluster&rsquo;s routing
        </h2>
        <p className="text-xs text-fg-mut">
          Every route this page draws is an Ingress in this API server, and that
          request failed — so the table would be a guess rather than an answer.
        </p>
        <p className="text-[11px] text-fg-fnt">{routeSources.error.message}</p>
      </Section>
    );
  }

  const troubled = groups.filter((group) => group.worst !== null);
  const settings = controller.data?.config
    ? readSettings(controller.data.config.data)
    : [];

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
          loading={routeSources.isPending}
          backingLoading={backing.isPending}
        />
      ),
    },
    {
      id: "annotations",
      label: "Annotations",
      glyph: viewGlyph(FileCode2),
      mark: annotationsMark(groups),
      content: <AnnotationsTab groups={groups} />,
    },
    {
      id: "settings",
      label: "Global settings",
      glyph: viewGlyph(SlidersHorizontal),
      mark: settings.length > 0 ? countMark(settings.length) : undefined,
      content: <SettingsTab controller={controller.data} settings={settings} />,
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
        title="ingress-nginx"
        count={
          routeSources.isPending
            ? undefined
            : `${plural(groups.length, "host")} across every namespace`
        }
        description="What this controller serves, where each hostname goes, and what its annotations actually do."
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
  groups: NginxHostGroup[],
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

/**
 * The strip counts what the app could not state, not what it could.
 *
 * A number of decoded annotations is inventory; a number of lines shown raw
 * is the one thing on this tab worth going and looking at, because it is
 * where the page stops being able to answer.
 */
function annotationsMark(groups: NginxHostGroup[]): DetailTabMark | undefined {
  const readings = allAnnotations(groups);
  if (readings.length === 0) return undefined;
  const snippets = readings.filter((reading) => reading.raw === "snippet");
  if (snippets.length > 0) {
    return severityMark(
      "warn",
      `${plural(snippets.length, "snippet")} of raw nginx config`
    );
  }
  return countMark(readings.length);
}

function allAnnotations(groups: NginxHostGroup[]): AnnotationReading[] {
  const seen = new Set<string>();
  const readings: AnnotationReading[] = [];
  for (const group of groups) {
    for (const route of group.routes) {
      const object = `${route.source.namespace}/${route.source.name}`;
      for (const reading of route.annotations) {
        const key = `${object}/${reading.key}`;
        if (seen.has(key)) continue;
        seen.add(key);
        readings.push(reading);
      }
    }
  }
  return readings;
}

// --- routes -------------------------------------------------------------

function RoutesTab({
  groups,
  sources,
  loading,
  backingLoading,
}: {
  groups: NginxHostGroup[];
  sources: NginxSources | null;
  loading: boolean;
  backingLoading: boolean;
}) {
  const [filter, setFilter] = useState("");

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
            (route.service?.name ?? "").toLowerCase().includes(needle)
        )
    );
  }, [groups, filter]);

  if (loading) {
    return <p className="text-xs text-fg-fnt">Reading the routing table…</p>;
  }

  if (groups.length === 0) {
    return (
      <div className="max-w-[64ch]">
        <p className="text-xs text-fg-mut">
          ingress-nginx is running here and nothing routes to it.
        </p>
        <p className="mt-1.5 text-[11px] text-fg-fnt">
          No Ingress in this cluster names an IngressClass this controller
          claims. An Ingress naming a class nothing serves is correct YAML with
          no events and no error, and is simply never served — which is the
          usual outcome of installing a second controller beside the one the
          cluster shipped with.
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
            openByDefault={group.worst === "err" && broken <= AUTO_OPEN}
          />
        ))
      )}
    </div>
  );
}

function hostState(group: NginxHostGroup): { text: string; tone: Tone } {
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
  if (group.findings.some((finding) => finding.kind === "orphanCanary")) {
    return { text: "canary shadowing nothing", tone: "warn" };
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
  group: NginxHostGroup;
  sources: NginxSources | null;
  openByDefault: boolean;
}) {
  const state = hostState(group);
  const tls = group.tlsSecrets[0];

  return (
    <TroubleRow
      title={group.host ?? "any host"}
      copy={group.host ?? undefined}
      meta={
        <>
          {plural(group.routes.length, "path")}
          {group.split && ` · split ${splitSummary(group)}`}
          {tls ? ` · TLS from ${tls.secretName}` : " · no TLS"}
        </>
      }
      state={state}
      openByDefault={openByDefault}
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

/** "80/20" — one host, divided, which is what a canary pair actually is. */
function splitSummary(group: NginxHostGroup): string {
  const split = group.split;
  if (!split) return "";
  const shares = split.canaries.map((route) =>
    route.canary?.weight !== null && route.canary?.weight !== undefined
      ? String(route.canary.weight)
      : "?"
  );
  const primary =
    split.primaryShare === null ? "?" : String(split.primaryShare);
  return `${primary}/${shares.join("/")}${split.weightTotal === 100 ? "" : ` of ${split.weightTotal}`}`;
}

function Paths({
  group,
  sources,
}: {
  group: NginxHostGroup;
  sources: NginxSources | null;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      {group.routes.map((route) => (
        <PathRow
          key={route.key}
          route={route}
          group={group}
          sources={sources}
        />
      ))}
    </div>
  );
}

function PathRow({
  route,
  group,
  sources,
}: {
  route: NginxRoute;
  group: NginxHostGroup;
  sources: NginxSources | null;
}) {
  const backing = sources ? backingOf(route, sources) : null;
  const decoded = route.annotations.filter((reading) => reading.said !== null);

  return (
    <div className="grid grid-cols-[minmax(0,190px)_minmax(0,1fr)_auto] items-baseline gap-x-3 text-[11.5px] text-fg-mut">
      <span className="truncate font-mono text-fg-mid">
        {route.path}
        {route.pathType && route.pathType !== "Prefix" && (
          <span className="ml-1 text-fg-fnt">{route.pathType}</span>
        )}
      </span>
      <span className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
        <Share route={route} group={group} />
        {decoded.length > 0 && (
          <span className="text-fg-fnt">
            {plural(decoded.length, "annotation")} ·
          </span>
        )}
        <span className="text-fg-fnt">to</span>
        {route.service ? (
          <>
            <ResourceRef
              kind="Service"
              name={route.service.name}
              namespace={route.service.namespace}
              showKind={false}
            />
            {route.service.port !== "" && (
              <span className="text-fg-fnt">:{route.service.port}</span>
            )}
          </>
        ) : route.resourceBackend ? (
          <span className="font-mono text-fg-mid">{route.resourceBackend}</span>
        ) : (
          <span className="text-err">no service</span>
        )}
        <span className="text-fg-fnt">
          ·{" "}
          <ResourceRef
            kind="Ingress"
            name={route.source.name}
            namespace={route.source.namespace}
            showKind={false}
          />
        </span>
      </span>
      <span className="text-[11px] text-fg-fnt">
        {route.service === null
          ? "not a Service"
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

/**
 * What share of the host this row takes.
 *
 * The whole point of the canary handling: two Ingresses are one host, and
 * the row that shadows and the row that is shadowed each say how much of it
 * they get, rather than both looking like they get all of it.
 */
function Share({ route, group }: { route: NginxRoute; group: NginxHostGroup }) {
  const split = group.split;
  if (!split) return null;

  if (route.canary) {
    const canary = route.canary;
    if (canary.byHeader) {
      return (
        <span className="text-info">
          canary · when {canary.byHeader}
          {canary.byHeaderValue ? `: ${canary.byHeaderValue}` : ": always"}
        </span>
      );
    }
    if (canary.byCookie) {
      return (
        <span className="text-info">canary · cookie {canary.byCookie}</span>
      );
    }
    return (
      <span className="text-info">
        canary ·{" "}
        {canary.weight === null
          ? "no weight set, so nothing goes here"
          : canary.weightTotal === 100
            ? `${canary.weight}%`
            : `${canary.weight} of ${canary.weightTotal}`}
      </span>
    );
  }

  if (route !== split.primary) return null;
  return (
    <span className="text-fg-fnt">
      {split.primaryShare === null
        ? "the rest"
        : split.weightTotal === 100
          ? `${split.primaryShare}%`
          : `${split.primaryShare} of ${split.weightTotal}`}{" "}
      ·
    </span>
  );
}

// --- the chain ----------------------------------------------------------

function HostChain({
  group,
  sources,
}: {
  group: NginxHostGroup;
  sources: NginxSources;
}) {
  const route = group.chainFor;
  const backing = backingOf(route, sources);
  const decoded = route.annotations.filter((reading) => reading.said !== null);
  const raw = route.annotations.filter((reading) => reading.raw !== null);

  return (
    <div className="flex flex-col gap-1">
      {group.routes.length > 1 && (
        <span className="text-[10px] text-fg-fnt">
          the path through {route.path} on {route.source.name}
        </span>
      )}
      <Chain>
        <Column label="Listener">
          <Cell under={route.tlsSecret ? "TLS terminated here" : "no TLS here"}>
            {route.tlsSecret ? ":443" : ":80"}
          </Cell>
        </Column>
        <Column label="Rule">
          <Cell under={route.pathType ?? undefined}>
            {group.host ?? "any host"} {route.path}
          </Cell>
        </Column>
        <Column label="Annotations">
          {route.annotations.length === 0 ? (
            <div className="rounded-[4px] border border-hair px-2 py-1 font-mono text-[11px] text-fg-fnt opacity-60">
              none
            </div>
          ) : (
            <>
              {decoded.length > 0 && (
                <Cell under={plural(decoded.length, "decoded")}>
                  behaviour set here
                </Cell>
              )}
              {raw.length > 0 && (
                <Cell
                  warn={raw.some((reading) => reading.raw === "snippet")}
                  under="shown raw below"
                >
                  {plural(raw.length, "not read")}
                </Cell>
              )}
            </>
          )}
        </Column>
        <Column label="Service">
          {route.service ? (
            <Cell
              bad={backing.stop?.reason === "backendMissing"}
              under={`:${route.service.port || "?"} · ${route.service.namespace}`}
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
          {route.service === null ? (
            <Cell under="not a Service">—</Cell>
          ) : !backing.known ? (
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
      {route.tlsSecret && (
        <span className="text-[11px] text-fg-fnt">
          served under{" "}
          <ResourceRef
            kind="Secret"
            name={route.tlsSecret}
            namespace={route.source.namespace}
            showKind={false}
          />
        </span>
      )}
      <Annotations readings={route.annotations} />
    </div>
  );
}

/**
 * The annotations, decoded, with the raw key beside every line.
 *
 * The key is never dropped — not on the lines that were decoded and not on
 * the ones that were not — because the paraphrase is this app's and the key
 * is the reader's. Somebody comparing this against their own YAML has to be
 * able to find the line they wrote.
 */
function Annotations({ readings }: { readings: AnnotationReading[] }) {
  if (readings.length === 0) return null;

  return (
    <div className="mt-1 flex flex-col gap-1.5">
      {readings.map((reading) => (
        <AnnotationLine key={reading.key} reading={reading} />
      ))}
    </div>
  );
}

function AnnotationLine({ reading }: { reading: AnnotationReading }) {
  const snippet = reading.raw === "snippet";

  return (
    <div
      className={
        snippet
          ? "border-l-2 border-warn pl-2.5"
          : reading.raw
            ? "border-l-2 border-hair pl-2.5"
            : "pl-[10px]"
      }
    >
      <p
        className={
          reading.said
            ? "text-[11.5px] text-fg-mut"
            : snippet
              ? "text-[11.5px] text-warn"
              : "text-[11.5px] text-fg-fnt"
        }
      >
        {reading.said ??
          (snippet
            ? "Raw nginx configuration, injected verbatim"
            : "Shown as written")}
      </p>
      <p className="mt-0.5 select-text break-all font-mono text-[11px] text-fg-fnt">
        {reading.key}
        {reading.said ? `: ${reading.value}` : ""}
      </p>
      {!reading.said && (
        <>
          <pre className="mt-0.5 select-text whitespace-pre-wrap break-all rounded-[4px] border border-hair bg-hover px-2 py-1 font-mono text-[11px] text-fg-mid">
            {reading.value}
          </pre>
          <p className="mt-0.5 text-[11px] text-fg-fnt">
            {RAW_NOTE[reading.raw!]}
          </p>
        </>
      )}
    </div>
  );
}

// --- findings -----------------------------------------------------------

function Findings({
  group,
  brief,
}: {
  group: NginxHostGroup;
  brief?: boolean;
}) {
  const issuance = useCertificateIssuance(
    group.tlsSecrets[0]?.namespace,
    group.tlsSecrets.map((secret) => secret.secretName)
  );

  if (group.findings.length === 0) return null;

  const worthRepeating = group.findings.filter(
    (finding) => finding.kind !== "clear"
  );
  if (brief && worthRepeating.length === 0) return null;
  const shown = brief ? worthRepeating.slice(0, 1) : group.findings;
  const hidden = brief ? worthRepeating.length - 1 : 0;

  return (
    <div className="flex flex-col gap-2">
      {shown.map((finding, index) => {
        const said = describeFinding(finding);
        return (
          <FindingBlock key={index} tone={finding.severity} title={said.title}>
            {!brief && said.note}
            {!brief && finding.kind === "certificate" && (
              <RenewalNote
                issuance={issuance}
                secretName={finding.secretName}
              />
            )}
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

const STOP_UNDER: Record<ChainStop["reason"], string> = {
  backendMissing: "no service to send to",
  selectsNothing: "selector matches nothing",
  noneReady: "running, none ready",
  publishesNothing: "no port to send to",
};

function describeFinding(finding: Finding): { title: string; note: string } {
  switch (finding.kind) {
    case "stop": {
      const said = describeStop(finding.stop);
      return {
        title: `This host answers, and every request gets a 503 — ${said.title.charAt(0).toLowerCase()}${said.title.slice(1)}`,
        note: said.note,
      };
    }
    case "clear":
      return {
        title: "Served in the clear — nothing offers this host over TLS",
        note: finding.redirectAnyway
          ? "No Ingress under this host declares a certificate, so nginx serves it on :80 and nothing else. One of them does carry ssl-redirect, which reads like protection and is doing nothing: nginx applies that redirect only where the Ingress has a certificate to redirect to."
          : "No Ingress under this host declares a certificate, so nginx serves it on :80 and there is no encrypted way to reach it, even for a client that asks for one.",
      };
    case "duplicate":
      return {
        title: `Two Ingresses claim ${finding.path} on this host`,
        note: finding.winner
          ? `nginx serves ${finding.winner.source.namespace}/${finding.winner.source.name} — the older object wins a conflict — and writes a warning to its log that nothing else in this cluster surfaces. The other never fires.`
          : `nginx breaks the tie by creation time and serves the older object; these do not both state one, so which of them is serving the request is not something this app can say from here.`,
      };
    case "orphanCanary":
      return {
        title: `${finding.route.source.name} is a canary shadowing nothing`,
        note: "A canary Ingress is merged into the server block of a host another Ingress already serves. No other Ingress serves this host, so there is nothing to merge it into and nginx never routes a request to it — the object is correct YAML that does nothing at all.",
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

// --- annotations tab ----------------------------------------------------

/**
 * Every annotation in the cluster's nginx routing, by object.
 *
 * The Routes tab shows a host's annotations in the context of its chain;
 * this is the other question — *what has been switched on anywhere*, and in
 * particular where the app had to give up and print a string.
 */
function AnnotationsTab({ groups }: { groups: NginxHostGroup[] }) {
  const byObject = new Map<string, AnnotationReading[]>();
  for (const group of groups) {
    for (const route of group.routes) {
      const object = `${route.source.namespace}/${route.source.name}`;
      if (!byObject.has(object)) byObject.set(object, route.annotations);
    }
  }
  const objects = [...byObject.entries()].filter(
    ([, readings]) => readings.length > 0
  );

  if (objects.length === 0) {
    return (
      <p className="max-w-[64ch] text-xs text-fg-mut">
        No Ingress this controller serves carries an nginx annotation. Every
        route is being served with the controller&rsquo;s own defaults, which
        the Global settings tab lists.
      </p>
    );
  }

  const readings = objects.flatMap(([, entries]) => entries);
  const raw = readings.filter((reading) => reading.raw !== null);

  return (
    <Section>
      <SectionHeader
        title="Annotations"
        count={readings.length}
        description="What each one does, with the key it came from beside it. The ones this app will not paraphrase say so and print the value instead."
      />
      {raw.length > 0 && (
        <p className="max-w-[92ch] border-l-2 border-hair pl-2.5 text-[11.5px] text-fg-mut">
          {plural(raw.length, "line")} here {raw.length === 1 ? "is" : "are"}{" "}
          shown as written. A wrong paraphrase of a routing rule is worse than
          the annotation nobody read, because this time somebody believed it.
        </p>
      )}
      <div className="flex flex-col gap-4">
        {objects.map(([object, entries]) => (
          <div key={object} className="flex flex-col gap-1.5">
            <span className="font-mono text-[11.5px] text-fg-mid">
              {object}
            </span>
            <Annotations readings={entries} />
          </div>
        ))}
      </div>
    </Section>
  );
}

// --- global settings ----------------------------------------------------

/**
 * The ConfigMap that changes every route at once.
 *
 * Invisible today at any price: it is a ConfigMap like any other on the
 * ConfigMaps page, its keys are undocumented strings there, and nothing in
 * the app connects it to the routes it governs.
 */
function SettingsTab({
  controller,
  settings,
}: {
  controller: ControllerInfo | undefined;
  settings: SettingReading[];
}) {
  if (!controller) {
    return <p className="text-xs text-fg-fnt">Reading the controller…</p>;
  }
  if (!controller.config) {
    return (
      <div className="max-w-[64ch]">
        <p className="text-xs text-fg-mut">
          This cluster has no global nginx settings to show.
        </p>
        <p className="mt-1.5 text-[11px] text-fg-fnt">
          {controller.problem ??
            "The controller names no ConfigMap, so every setting comes from its own defaults."}
        </p>
      </div>
    );
  }

  const { config } = controller;

  return (
    <Section>
      <SectionHeader
        title="Settings that apply to every route"
        count={settings.length}
        description="The ConfigMap the controller was started with. A key set here changes the behaviour of every host on the Routes tab at once, unless an Ingress overrides it with the annotation of the same name."
      />
      <p className="text-[11px] text-fg-fnt">
        <ResourceRef
          kind="ConfigMap"
          name={config.name}
          namespace={config.namespace}
          showKind={false}
        />{" "}
        — named in the controller&rsquo;s own <code>--configmap</code> flag,
        which is the only place in this cluster that says which ConfigMap is the
        global one.
      </p>
      {config.problem ? (
        <p className="text-[11px] text-warn">{config.problem}</p>
      ) : settings.length === 0 ? (
        <p className="text-[11px] text-fg-fnt">
          It is empty, so every setting is the controller&rsquo;s own default.
        </p>
      ) : (
        <div className="flex flex-col">
          {settings.map((setting) => (
            <div
              key={setting.key}
              className="grid grid-cols-[minmax(0,260px)_minmax(0,1fr)] items-baseline gap-x-3 border-b border-hair py-1.5"
            >
              <div className="flex min-w-0 flex-col">
                <span className="truncate font-mono text-[11.5px] text-fg-mid">
                  {setting.key}
                </span>
                <span className="select-text break-all font-mono text-[11px] text-fg-fnt">
                  {setting.value}
                </span>
              </div>
              <div className="flex min-w-0 flex-col">
                <span
                  className={
                    setting.said
                      ? "text-[11.5px] text-fg-mut"
                      : "text-[11.5px] text-fg-fnt"
                  }
                >
                  {setting.said ?? RAW_NOTE[setting.raw!]}
                </span>
                {setting.overridable && (
                  <span className="text-[11px] text-fg-fnt">
                    an Ingress may override this one with the annotation of the
                    same name
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

// --- controller ---------------------------------------------------------

function ControllerTab({
  controller,
  sources,
}: {
  controller: ControllerInfo | undefined;
  sources: NginxSources | null;
}) {
  if (!controller) {
    return <p className="text-xs text-fg-fnt">Reading the controller…</p>;
  }
  const classes = sources ? nginxClasses(sources.classes) : [];

  return (
    <div className="flex flex-col gap-[22px]">
      <Section>
        <SectionHeader
          title="The controller"
          description="Where an nginx problem is actually diagnosed: its own pods, and its own logs."
        />
        {controller.workload ? (
          <div className="flex flex-col gap-1 text-[11.5px] text-fg-mut">
            <span className="flex flex-wrap items-baseline gap-x-2">
              <ResourceRef
                kind="Deployment"
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
            ingress-nginx is running and claims no IngressClass, so no Ingress
            in this cluster can reach it by class.
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
        {controller.watching.controllerClass && (
          <p className="text-[11px] text-fg-fnt">
            Started with{" "}
            <span className="font-mono">
              --controller-class={controller.watching.controllerClass}
            </span>
            , which is the string it looks for in an IngressClass.
          </p>
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
