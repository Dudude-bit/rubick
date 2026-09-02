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

import { sayWords } from "@/i18n/say";
import { useCallback, useMemo, useState } from "react";
import type { ServiceStop } from "../ingress";
import { useServiceRoutes } from "@/hooks/useServiceRoutes";
import { useIngressTls } from "@/hooks/useIngressTls";
import {
  Box,
  FileCode2,
  Globe,
  Network,
  SlidersHorizontal,
} from "lucide-react";

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
import { RoutingMap } from "../routing-map";
import { routingMap } from "./map";
import {
  Chain,
  Cell,
  Column,
  FilterBox,
  Finding as FindingBlock,
  TroubleRow,
  type Tone,
} from "../page-kit";
import { rawNote, type AnnotationReading } from "./annotations";
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
import { problemWords } from "@/lib/certificates";
import { T } from "@/i18n/T";
import { useT } from "@/i18n/useT";
import type { en } from "@/i18n/catalogue";

/** Past this many troubled hosts, nothing opens itself. */
const AUTO_OPEN = 8;

export default function IngressNginxPage() {
  const t = useT();
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") ?? "routes";

  const routeSources = useRouteSources();
  const backing = useBacking();
  const controller = useController();

  const routes = useMemo(
    () =>
      routeSources.data
        ? allRoutes({ ...routeSources.data, services: [], published: [] }, t)
        : [],
    [routeSources.data, t]
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
    () => (sources ? hostGroups(sources, t) : []),
    // `sources` is rebuilt every render; the inputs it is built from are what
    // actually change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [routeSources.data, backing.data, certificates.size, upstreamTls]
  );

  if (routeSources.error) {
    return (
      <Section className="max-w-[64ch] py-8">
        <h2 className="text-[13px] font-semibold tracking-tight text-err">
          {t("empty", "couldNotReadRouting")}
        </h2>
        <p className="text-xs text-fg-mut">
          {t("empty", "routingRequestFailed")}
        </p>
        <p className="text-[11px] text-fg-fnt">{routeSources.error.message}</p>
      </Section>
    );
  }

  const troubled = groups.filter((group) => group.worst !== null);
  const settings = controller.data?.config
    ? readSettings(controller.data.config.data, t)
    : [];

  const tabs: DetailTab[] = [
    {
      id: "routes",
      label: t("nav", "routes"),
      glyph: viewGlyph(Globe),
      mark: routesMark(groups, troubled.length, t),
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
      content: (
        <MapTab
          groups={groups}
          sources={sources}
          loading={routeSources.isPending}
        />
      ),
    },
    {
      id: "annotations",
      label: t("columns", "annotations"),
      glyph: viewGlyph(FileCode2),
      mark: annotationsMark(groups, t),
      content: <AnnotationsTab groups={groups} />,
    },
    {
      id: "settings",
      label: t("nav", "globalSettings"),
      glyph: viewGlyph(SlidersHorizontal),
      mark: settings.length > 0 ? countMark(settings.length) : undefined,
      content: <SettingsTab controller={controller.data} settings={settings} />,
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
        title="ingress-nginx"
        count={
          routeSources.isPending
            ? undefined
            : t("count", "hostsAcrossNamespaces", { n: groups.length })
        }
        description={t("empty", "nginxPageDescription")}
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

/**
 * The shape across hosts: which hostnames land on the same Service. The
 * namespace filter and the rest-on-a-node highlight live in the map itself.
 */
function MapTab({
  groups,
  sources,
  loading,
}: {
  groups: NginxHostGroup[];
  sources: NginxSources | null;
  loading: boolean;
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
  if (!data || groups.length === 0) {
    return (
      <p className="max-w-[64ch] text-xs text-fg-mut">
        <T section="empty" k="nothingRoutesThroughController" />
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

function routesMark(
  groups: NginxHostGroup[],
  troubled: number,
  t: ReturnType<typeof useT>
): DetailTabMark | undefined {
  if (groups.length === 0) return undefined;
  const worst = groups.some((group) => group.worst === "err") ? "err" : "warn";
  return troubled > 0
    ? severityMark(
        worst,
        t("count", "hostsNeedAttention", {
          n: troubled,
          total: groups.length,
        })
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
function annotationsMark(
  groups: NginxHostGroup[],
  t: ReturnType<typeof useT>
): DetailTabMark | undefined {
  const readings = allAnnotations(groups);
  if (readings.length === 0) return undefined;
  const snippets = readings.filter((reading) => reading.raw === "snippet");
  if (snippets.length > 0) {
    return severityMark(
      "warn",
      t("count", "snippetsOfRawNginx", { n: snippets.length })
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
  const t = useT();
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
    return (
      <p className="text-xs text-fg-fnt">{t("empty", "readingRoutingTable")}</p>
    );
  }

  if (groups.length === 0) {
    return (
      <div className="max-w-[64ch]">
        <p className="text-xs text-fg-mut">
          {t("empty", "nginxRunningNothingRoutes")}
        </p>
        <p className="mt-1.5 text-[11px] text-fg-fnt">
          {t("empty", "nginxNoIngressClaimsClass")}
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
          placeholder={t("action", "filterByHostServiceObject")}
          label={t("action", "filterHosts")}
        />
        <span className="text-[11px] text-fg-fnt">
          {filter.trim() !== ""
            ? t("count", "nOfTotal", {
                n: shown.length,
                total: groups.length,
              })
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
          {t("empty", "noHostServiceObjectMatches")}
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

function hostState(
  group: NginxHostGroup,
  t: ReturnType<typeof useT>
): { text: string; tone: Tone } {
  const stop = group.findings.find((finding) => finding.kind === "stop");
  if (stop) return { text: t("empty", "nothingBehindIt"), tone: "err" };
  const certificate = group.findings.find(
    (finding) => finding.kind === "certificate" && finding.severity === "err"
  );
  if (certificate) {
    return {
      text:
        certificate.kind === "certificate" && certificate.expiry?.expired
          ? t("empty", "certificateExpired")
          : t("empty", "certificateRunningOut"),
      tone: "err",
    };
  }
  if (group.findings.some((finding) => finding.kind === "orphanCanary")) {
    return { text: t("empty", "canaryShadowingNothing"), tone: "warn" };
  }
  if (group.findings.some((finding) => finding.kind === "clear")) {
    return { text: t("empty", "servedInTheClear"), tone: "warn" };
  }
  if (group.findings.length > 0) {
    return { text: t("empty", "worthALook"), tone: "warn" };
  }
  return { text: t("empty", "serving"), tone: "ok" };
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
  const t = useT();
  const state = hostState(group, t);
  const tls = group.tlsSecrets[0];

  return (
    <TroubleRow
      title={group.host ?? t("empty", "anyHost")}
      copy={group.host ?? undefined}
      meta={
        <>
          {t("count", "paths", { n: group.routes.length })}
          {group.split &&
            ` · ${t("empty", "splitShares", { shares: splitSummary(group) })}`}
          {tls
            ? ` · ${t("empty", "tlsFrom", { name: tls.secretName })}`
            : ` · ${t("empty", "noTls")}`}
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
  const t = useT();
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
            {t("count", "annotations", { n: decoded.length })} ·
          </span>
        )}
        <span className="text-fg-fnt">{t("empty", "toTarget")}</span>
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
          <span className="text-err">{t("empty", "noServiceBackend")}</span>
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
          ? t("empty", "notAService")
          : backing && !backing.known
            ? "…"
            : backing?.stop
              ? "—"
              : backing
                ? t("count", "nReady", { n: backing.ready })
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
  const t = useT();
  const split = group.split;
  if (!split) return null;

  if (route.canary) {
    const canary = route.canary;
    if (canary.byHeader) {
      return (
        <span className="text-info">
          {t("empty", "canaryWhenHeader", { header: canary.byHeader })}
          {canary.byHeaderValue
            ? `: ${canary.byHeaderValue}`
            : `: ${t("empty", "canaryAlways")}`}
        </span>
      );
    }
    if (canary.byCookie) {
      return (
        <span className="text-info">
          {t("empty", "canaryCookie", { cookie: canary.byCookie })}
        </span>
      );
    }
    return (
      <span className="text-info">
        canary ·{" "}
        {canary.weight === null
          ? t("empty", "canaryNoWeight")
          : canary.weightTotal === 100
            ? `${canary.weight}%`
            : t("count", "nOfTotal", {
                n: canary.weight,
                total: canary.weightTotal,
              })}
      </span>
    );
  }

  if (route !== split.primary) return null;
  return (
    <span className="text-fg-fnt">
      {split.primaryShare === null
        ? t("empty", "theRest")
        : split.weightTotal === 100
          ? `${split.primaryShare}%`
          : t("count", "nOfTotal", {
              n: split.primaryShare,
              total: split.weightTotal,
            })}{" "}
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
  const t = useT();
  const route = group.chainFor;
  const backing = backingOf(route, sources);
  const decoded = route.annotations.filter((reading) => reading.said !== null);
  const raw = route.annotations.filter((reading) => reading.raw !== null);

  return (
    <div className="flex flex-col gap-1">
      {group.routes.length > 1 && (
        <span className="text-[10px] text-fg-fnt">
          {t("empty", "pathThroughOn", {
            path: route.path,
            name: route.source.name,
          })}
        </span>
      )}
      <Chain>
        <Column label={t("columns", "listener")}>
          <Cell
            under={
              route.tlsSecret
                ? t("empty", "tlsTerminatedHere")
                : t("empty", "noTlsHere")
            }
          >
            {route.tlsSecret ? ":443" : ":80"}
          </Cell>
        </Column>
        <Column label={t("columns", "rule")}>
          <Cell under={route.pathType ?? undefined}>
            {group.host ?? t("empty", "anyHost")} {route.path}
          </Cell>
        </Column>
        <Column label={t("columns", "annotations")}>
          {route.annotations.length === 0 ? (
            <div className="rounded-[4px] border border-hair px-2 py-1 font-mono text-[11px] text-fg-fnt opacity-60">
              {t("empty", "noneLower")}
            </div>
          ) : (
            <>
              {decoded.length > 0 && (
                <Cell under={t("count", "nDecoded", { n: decoded.length })}>
                  {t("empty", "behaviourSetHere")}
                </Cell>
              )}
              {raw.length > 0 && (
                <Cell
                  warn={raw.some((reading) => reading.raw === "snippet")}
                  under={t("empty", "shownRawBelow")}
                >
                  {t("count", "nNotRead", { n: raw.length })}
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
            <Cell under={t("empty", "apiObjectNotService")}>
              {route.resourceBackend}
            </Cell>
          ) : (
            <Cell bad>{t("empty", "noneLower")}</Cell>
          )}
        </Column>
        <Column label={t("columns", "published")}>
          {route.service === null ? (
            <Cell under={t("empty", "notAService")}>—</Cell>
          ) : !backing.known ? (
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
      {route.tlsSecret && (
        <span className="text-[11px] text-fg-fnt">
          {t("empty", "servedUnder")}{" "}
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
  const t = useT();
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
            ? t("empty", "rawNginxConfig")
            : t("empty", "shownAsWritten"))}
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
            {rawNote(reading.raw!, t)}
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
  const t = useT();
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
        const said = describeFinding(finding, t);
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
          {t("empty", "andMoreOpenRow", { n: hidden })}
        </span>
      )}
    </div>
  );
}

const STOP_UNDER: Record<ServiceStop["reason"], keyof typeof en.empty> = {
  backendMissing: "stopNoServiceToSendTo",
  selectsNothing: "stopSelectorMatchesNothing",
  publishesNothingYet: "stopNothingPublishedYet",
  noneReady: "stopRunningNoneReady",
  publishesNothing: "stopNoPortToSendTo",
};

function describeFinding(
  finding: Finding,
  t: ReturnType<typeof useT>
): { title: string; note: string } {
  switch (finding.kind) {
    case "stop": {
      const said = describeStop(finding.stop, t);
      return {
        title: t("empty", "everyRequest503", {
          reason: `${said.title.charAt(0).toLowerCase()}${said.title.slice(1)}`,
        }),
        note: said.note,
      };
    }
    case "clear":
      return {
        title: t("empty", "servedInClearTitle"),
        note: finding.redirectAnyway
          ? t("empty", "nginxClearRedirectAnyway")
          : t("empty", "nginxClearNote"),
      };
    case "duplicate":
      return {
        title: t("empty", "twoIngressesClaimPath", { path: finding.path }),
        note: finding.winner
          ? t("empty", "nginxDuplicateWinner", {
              object: `${finding.winner.source.namespace}/${finding.winner.source.name}`,
            })
          : t("empty", "nginxDuplicateTie"),
      };
    case "orphanCanary":
      return {
        title: t("empty", "canaryShadowingNothingTitle", {
          name: finding.route.source.name,
        }),
        note: t("empty", "canaryShadowingNothingNote"),
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

// --- annotations tab ----------------------------------------------------

/**
 * Every annotation in the cluster's nginx routing, by object.
 *
 * The Routes tab shows a host's annotations in the context of its chain;
 * this is the other question — *what has been switched on anywhere*, and in
 * particular where the app had to give up and print a string.
 */
function AnnotationsTab({ groups }: { groups: NginxHostGroup[] }) {
  const t = useT();
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
        {t("empty", "noNginxAnnotations")}
      </p>
    );
  }

  const readings = objects.flatMap(([, entries]) => entries);
  const raw = readings.filter((reading) => reading.raw !== null);

  return (
    <Section>
      <SectionHeader
        title={t("columns", "annotations")}
        count={readings.length}
        description={t("empty", "annotationsDescription")}
      />
      {raw.length > 0 && (
        <p className="max-w-[92ch] border-l-2 border-hair pl-2.5 text-[11.5px] text-fg-mut">
          {t("count", "linesShownAsWritten", { n: raw.length })}{" "}
          {t("empty", "wrongParaphraseNote")}
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
  const t = useT();
  if (!controller) {
    return (
      <p className="text-xs text-fg-fnt">{t("empty", "readingController")}</p>
    );
  }
  if (!controller.config) {
    return (
      <div className="max-w-[64ch]">
        <p className="text-xs text-fg-mut">
          {t("empty", "noGlobalNginxSettings")}
        </p>
        <p className="mt-1.5 text-[11px] text-fg-fnt">
          {controller.problem
            ? sayWords(controller.problem, t)
            : t("empty", "controllerNamesNoConfigMap")}
        </p>
      </div>
    );
  }

  const { config } = controller;

  return (
    <Section>
      <SectionHeader
        title={t("empty", "settingsEveryRouteTitle")}
        count={settings.length}
        description={t("empty", "settingsEveryRouteDescription")}
      />
      <p className="text-[11px] text-fg-fnt">
        <ResourceRef
          kind="ConfigMap"
          name={config.name}
          namespace={config.namespace}
          showKind={false}
        />{" "}
        {t("empty", "namedInConfigmapFlagPre")}
        <code>--configmap</code>
        {t("empty", "namedInConfigmapFlagPost")}
      </p>
      {config.problem ? (
        <p className="text-[11px] text-warn">{sayWords(config.problem, t)}</p>
      ) : settings.length === 0 ? (
        <p className="text-[11px] text-fg-fnt">
          {t("empty", "configMapEmptyDefaults")}
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
                  {setting.said ?? rawNote(setting.raw!, t)}
                </span>
                {setting.overridable && (
                  <span className="text-[11px] text-fg-fnt">
                    {t("empty", "ingressMayOverride")}
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
  const t = useT();
  if (!controller) {
    return (
      <p className="text-xs text-fg-fnt">{t("empty", "readingController")}</p>
    );
  }
  const classes = sources ? nginxClasses(sources.classes) : [];

  return (
    <div className="flex flex-col gap-[22px]">
      <Section>
        <SectionHeader
          title={t("empty", "theControllerTitle")}
          description={t("empty", "theControllerDescription")}
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
                {t("count", "ofTotalReady", {
                  n: controller.workload.ready,
                  total: controller.workload.desired,
                })}{" "}
                · {controller.workload.namespace}
              </span>
            </span>
            {controller.workload.image && (
              <span className="font-mono text-[11px] text-fg-fnt">
                {controller.workload.image}
              </span>
            )}
            {controller.problem && (
              <p className="text-[11px] text-warn">
                {sayWords(controller.problem, t)}
              </p>
            )}
          </div>
        ) : (
          <p className="max-w-[64ch] text-[11px] text-fg-fnt">
            {controller.problem && sayWords(controller.problem, t)}
          </p>
        )}
      </Section>

      <Section>
        <SectionHeader
          title={t("empty", "classesItClaims")}
          count={classes.length}
          description={t("empty", "classesItClaimsDescription")}
        />
        {classes.length === 0 ? (
          <p className="text-[11px] text-warn">
            {t("empty", "nginxClaimsNoClass")}
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
                    {t("empty", "clustersDefault")}
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
            {t("empty", "startedWithPre")}
            <span className="font-mono">
              --controller-class={controller.watching.controllerClass}
            </span>
            {t("empty", "startedWithPost")}
          </p>
        )}
      </Section>

      {controller.args.length > 0 && (
        <Section>
          <SectionHeader
            title={t("empty", "staticConfiguration")}
            count={controller.args.length}
            description={t("empty", "staticConfigurationDescription")}
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
