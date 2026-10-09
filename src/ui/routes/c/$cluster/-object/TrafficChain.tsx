/**
 * How traffic gets here — and where it stops.
 *
 * On the Overview rather than behind a tab: it is the first question anybody
 * asks about a running workload, and the answer otherwise costs three list
 * pages and a squint at label selectors.
 *
 * A stop is a hop of its own carrying a sentence a person can act on, and
 * `noneReady` — pods running, none of them ready — gets the loudest one,
 * because that is the case every list page in this app draws as healthy.
 * Where there is nothing to draw at all the whole thing collapses to one
 * line: a Deployment with no Service in front of it must not cost a diagram.
 */

import { joinSayings, sayWords } from "@/i18n/say";
import { Link } from "@tanstack/react-router";
import {
  CircleSlash,
  Clock,
  EyeOff,
  PauseCircle,
  Unplug,
  type LucideIcon,
} from "lucide-react";

import { Section, SectionHeader } from "@/components/ui/section";
import { Unknown } from "@/components/ui/unknown";
import {
  CopyableAddress,
  CopyableAddresses,
} from "@/components/ui/copyable-value";
import { useIngressRouting } from "@/hooks/useIngressRouting";
import { cn } from "@/lib/utils";
import {
  chainSilence,
  closestSelector,
  nearMissWords,
  describeExistence,
  hopTone,
  trafficChains,
  unservedIngresses,
  type ChainHop,
  type ChainHopStop,
  type HopTone,
  type StopMood,
} from "@/lib/connections";
import type { ConnectionsRead } from "@/hooks/useConnections";
import type { Issuance } from "@/hooks/useCertificateIssuance";
import { edgeKey, useServiceEdge, type ServiceEdges } from "./useServiceEdge";
import {
  useServicesRoutes,
  type ServicesRoutes,
} from "@/hooks/useServiceRoutes";
import type { ServiceRoute } from "@/integrations";
import { CertificateLine } from "./CertificateFacts";
import { RenewalNote } from "@/components/object/IssuanceChain";
import { ResourceRef } from "@/components/object/ResourceRef";
import {
  ResourceName,
  RESOURCE_NAME_SHELL,
} from "@/components/object/ResourceName";
import type {
  IngressClassBinding,
  ObjectRef,
  ResourceConnections,
  TlsCertificate,
} from "@/generated/types";
import { useT } from "@/i18n/useT";
import { parts } from "@/i18n/parts";
import { TONE_TEXT } from "@/lib/tone";
import { errorToShow } from "@/lib/error-utils";

/**
 * A name at a hop. A missing object keeps its glyph and its hue and loses
 * only the link: the reader still has to recognise the name at fault, and a
 * link to a page that 404s is a second dead end.
 */
function HopName({ object }: { object: ObjectRef }) {
  if (object.existence === "missing") {
    return (
      <span className={RESOURCE_NAME_SHELL}>
        <ResourceName kind={object.kind} name={object.name} showKind={false} />
      </span>
    );
  }
  return (
    <ResourceRef
      kind={object.kind}
      name={object.name}
      namespace={object.namespace}
      showKind={false}
    />
  );
}

// A quiet ring for the ordinary hop: the rail's job is to carry the eye,
// not to compete with the verdicts riding on it. Trouble keeps its hue.
const NODE_TONE: Record<HopTone, string> = {
  on: "border-fg-mut",
  info: "border-info",
  unknown: "border-fg-fnt",
  warn: "border-warn",
  bad: "border-err",
};

/** How a stop's sentence is drawn: a fault in red, the rest by what they are. */
const STOP_LOOK: Record<
  StopMood,
  { title: string; note: string; icon: LucideIcon | null }
> = {
  fault: { title: "text-err", note: "text-err/85", icon: null },
  idle: { title: "text-fg-mid", note: "text-fg-mut", icon: PauseCircle },
  coming: { title: "text-info", note: "text-fg-mut", icon: Clock },
  unchecked: { title: "text-fg-mid", note: "text-fg-mut", icon: EyeOff },
};

function StopWords({ hop }: { hop: ChainHopStop }) {
  const look = STOP_LOOK[hop.mood];
  const Icon = look.icon;
  return (
    <>
      <p className={cn("flex items-center gap-1.5 text-xs", look.title)}>
        {Icon && <Icon className="h-3 w-3 flex-none" aria-hidden="true" />}
        {hop.title}
      </p>
      {/* A repair is a paragraph, and a paragraph set to the width of a
          1600px window is one nobody finishes reading. */}
      <p className={cn("max-w-[92ch] text-[11px]", look.note)}>{hop.note}</p>
    </>
  );
}

/**
 * The dot and the run of line under it — the chain's spine. Shared with the
 * peek's chain, so a hop reads the same wherever it is drawn. No arrowheads:
 * the chain only ever runs downward, and the line already says so.
 */
export function Rail({
  tone,
  into,
  here = false,
}: {
  tone: HopTone;
  into: HopTone | null;
  /** The chain's own subject — filled, with a halo: "you are standing here". */
  here?: boolean;
}) {
  return (
    <div className="flex flex-col items-center">
      <span
        aria-hidden="true"
        data-testid={here ? "rail-here" : undefined}
        className={cn(
          "mt-[5px] h-[7px] w-[7px] flex-none rounded-full border-[1.5px]",
          NODE_TONE[tone],
          here && "border-fg bg-fg ring-[3px] ring-fg/20"
        )}
      />
      {into && (
        <span
          aria-hidden="true"
          className={cn(
            "min-h-[10px] w-px flex-1",
            into === "bad" ? "bg-err/40" : "bg-hair"
          )}
        />
      )}
    </div>
  );
}

/**
 * Who picks this Ingress up.
 *
 * The unmatched case is the one worth the width: correct YAML, no events,
 * no error, and nothing serving it. Naming the classes that do exist turns
 * "it does not work" into a one-word fix.
 */
function Controller({
  binding,
  brief,
}: {
  binding: IngressClassBinding;
  brief: boolean;
}) {
  const t = useT();
  if (!binding.resolved && brief && binding.requested) {
    return (
      <p
        role="img"
        aria-label={t("empty", "noIngressClassNamed", {
          name: binding.requested,
        })}
        className="flex items-center gap-1 text-xs text-err"
      >
        <CircleSlash className="h-3 w-3 flex-none" />
        <span className="font-mono">{binding.requested}</span>
      </p>
    );
  }
  if (!binding.resolved) {
    return (
      <>
        <p className="text-xs text-err">
          {binding.requested
            ? t("empty", "noIngressClassNamed", { name: binding.requested })
            : t("empty", "ingressNamesNoClass")}
        </p>
        <p className="max-w-[92ch] text-[11px] text-err/85">
          {t("empty", "nothingPickedIngressUp")}{" "}
          {binding.available.length > 0
            ? t("empty", "clusterHasClasses", {
                list: binding.available.map((c) => c.name).join(", "),
              })
            : t("empty", "clusterHasNoIngressClass")}
        </p>
      </>
    );
  }
  return (
    <>
      <span className="flex flex-wrap items-baseline gap-x-2">
        <span className={RESOURCE_NAME_SHELL}>
          <ResourceName
            kind="IngressClass"
            name={binding.resolved}
            showKind={false}
          />
        </span>
        <span className="text-xs text-fg-mid">
          {t("action", "servingClass", { name: binding.resolved })}
          {binding.viaDefault ? t("action", "andClusterDefault") : ""}
        </span>
      </span>
      {binding.controller && (
        <p className="font-mono text-[11px] text-fg-fnt">
          {binding.controller}
        </p>
      )}
    </>
  );
}

/**
 * What a cloud's own object configures about the way into this Service.
 *
 * Under the Service hop and never instead of it, like the renewal note: the
 * Service's own ports and selector stay drawn above, and this is a line below
 * them or nothing at all.
 *
 * The summary is stated as configuration, because that is what these objects
 * are: "health check HTTP :8080/healthz" is the probe the cloud will run, not
 * a claim that it passes, which no object in this cluster knows. Only
 * `problem` may carry a colour, and only a supplier that read a real status
 * or a real missing object may set it.
 */
function EdgeNote({
  edge,
  object,
}: {
  edge: ServiceEdges | undefined;
  object: ObjectRef;
}) {
  const t = useT();
  if (!edge?.available || edge.error) return null;
  const configs = edge.configs.get(
    edgeKey(object.namespace ?? "", object.name)
  );
  if (!configs || configs.length === 0) return null;

  return (
    <>
      {configs.map((config) => (
        <p
          key={`${config.source.kind}/${config.source.name}`}
          className="text-[11px] text-fg-fnt"
        >
          {config.source.to ? (
            <Link
              {...config.source.to}
              className="font-mono text-info hover:underline"
            >
              {config.source.name}
            </Link>
          ) : (
            <span className="font-mono">{config.source.name}</span>
          )}{" "}
          {joinSayings(config.summary, t)}
          {config.problem && (
            <span className={TONE_TEXT[config.problem.tone]}>
              {": "}
              {sayWords(config.problem.text, t)}
            </span>
          )}
        </p>
      ))}
    </>
  );
}

/**
 * The ways in that live in a vendor's own objects — an IngressRoute, and
 * nothing the backend's Ingress-only connection graph can see.
 *
 * Under the Service hop, beside the cloud's note, and filtered to sources
 * the core does not draw: a route the capability read off a plain Ingress is
 * the same way in the chain already shows as a hop, said twice.
 */
export function RoutesNote({ routes }: { routes: ServiceRoute[] | undefined }) {
  const t = useT();
  const vendors = (routes ?? []).filter(
    (route) => route.source.kind !== "Ingress"
  );
  if (vendors.length === 0) return null;
  const shown = vendors.slice(0, 6);

  return (
    <>
      {shown.map((route) => (
        <p
          key={`${route.host}${route.path}`}
          className="text-[11px] text-fg-fnt"
        >
          <RouteLine route={route} />
        </p>
      ))}
      {vendors.length > shown.length && (
        <p className="text-[11px] text-fg-fnt">
          {t("count", "andMore", { n: vendors.length - shown.length })}
        </p>
      )}
    </>
  );
}

/** The address a client types for this route, scheme included where known. */
// oxlint-disable-next-line react-refresh/only-export-components
export function routeAddress(route: ServiceRoute): string {
  const tail = route.path === "/" ? "" : route.path;
  return route.tls === null
    ? `${route.host}${tail}`
    : `${route.tls ? "https" : "http"}://${route.host}${tail}`;
}

/**
 * The object a route came from. A source that names its CRD is a real
 * reference — glyph, hue, peek — the same element every other object on
 * the line gets. The bare link is only the fallback for a vendor that
 * handed a path and nothing more.
 */
export function RouteSource({ route }: { route: ServiceRoute }) {
  if (route.source.crd) {
    return (
      <ResourceRef
        kind={route.source.kind}
        name={route.source.name}
        namespace={route.source.namespace}
        crd={route.source.crd}
        showKind={false}
      />
    );
  }
  if (route.to) {
    return (
      <Link {...route.to} className="font-mono text-info hover:underline">
        {route.source.name}
      </Link>
    );
  }
  return <span className="font-mono">{route.source.name}</span>;
}

/**
 * One route as a line: the address, then the object that states it. The
 * note above stacks these under a Service hop; the peek's chain draws the
 * same parts object-first, because there a route is a hop of its own.
 */
export function RouteLine({ route }: { route: ServiceRoute }) {
  const t = useT();
  return (
    <>
      <CopyableAddress
        value={routeAddress(route)}
        label={t("columns", "address")}
      />
      {route.h2c ? " (gRPC)" : ""}: {route.source.kind}{" "}
      <RouteSource route={route} />
    </>
  );
}

function Hop({
  hop,
  next,
  issuance,
  edge,
  routed,
  brief,
}: {
  hop: ChainHop;
  next: ChainHop | undefined;
  issuance: Issuance | undefined;
  edge: ServiceEdges | undefined;
  routed: ServicesRoutes | undefined;
  /** The class repair is said once above the paths. */
  brief: boolean;
}) {
  const t = useT();
  const last = next === undefined;
  return (
    <div className="grid grid-cols-[7px_minmax(0,1fr)] gap-x-2.5">
      {/* The run of line below a hop carries the colour of what comes next,
          so the segment leading into a stop is the part that turns red. */}
      <Rail
        tone={hopTone(hop)}
        into={next ? hopTone(next) : null}
        here={hop.at === "object" && hop.self}
      />
      <div className={cn("min-w-0", last ? "" : "pb-3")}>
        {hop.at === "object" && (
          <>
            <span className="flex flex-wrap items-baseline gap-x-2">
              {hop.self ? (
                // The selection tint the app already means "current" by —
                // the pill is the "you are here", the halo on its dot agrees.
                <span className={cn(RESOURCE_NAME_SHELL, "bg-sel")}>
                  <ResourceName
                    kind={hop.object.kind}
                    name={hop.object.name}
                    showKind={false}
                  />
                </span>
              ) : (
                <HopName object={hop.object} />
              )}
              {hop.detail && (
                <span className="font-mono text-xs text-fg-mid">
                  {hop.detail}
                </span>
              )}
              {hop.object.existence === "notChecked" && !hop.self && (
                <span className="text-[11px] text-warn">
                  {describeExistence(hop.object, t)}
                </span>
              )}
              {hop.self && (
                <span className="text-[11px] text-fg-fnt">
                  {t("action", "thisKindHere", { kind: hop.object.kind })}
                </span>
              )}
            </span>
            {hop.via && <p className="text-[11px] text-fg-fnt">{hop.via}</p>}
            {/* The address, on the clipboard: reconstructing it by hand from
                a host, a path and a guess at the scheme is the errand this
                view exists to save. */}
            {hop.urls.length > 0 && (
              <p className="mt-0.5 text-[11px]">
                <CopyableAddresses
                  values={hop.urls}
                  label={t("columns", "address")}
                />
              </p>
            )}
            {/* And what that hostname has to resolve to. A URL on its own is
                only half an address on a cluster whose DNS nobody has pointed
                yet, which is most of them — this is the number you put in
                `--resolve` or in `/etc/hosts` to check the rest of the chain
                without waiting for a zone to propagate. */}
            {hop.address?.state === "assigned" && (
              <p className="text-[11px] text-fg-fnt">
                {t("action", "atInline")}{" "}
                <CopyableAddresses
                  values={hop.address.addresses}
                  label={t("columns", "address")}
                />
              </p>
            )}
            {/* With no controller, the hop above already says none will come. */}
            {hop.address?.state === "pending" && (
              <p className="max-w-[92ch] text-[11px] text-warn">
                {t("empty", "noAddressYet")}
              </p>
            )}
            {hop.object.kind === "Service" && (
              <>
                <EdgeNote edge={edge} object={hop.object} />
                <RoutesNote
                  routes={routed?.routes.get(
                    `${hop.object.namespace ?? ""}/${hop.object.name}`
                  )}
                />
              </>
            )}
          </>
        )}
        {hop.at === "published" && (
          <span className="flex flex-wrap items-baseline gap-x-2">
            {hop.first ? (
              <HopName object={hop.first} />
            ) : (
              hop.address && (
                <span className="font-mono text-xs text-fg-mid">
                  {hop.address}
                </span>
              )
            )}
            <span
              className={cn(
                "text-[11px]",
                hop.tone === "warn" ? "text-warn" : "text-fg-fnt"
              )}
            >
              {hop.summary}
            </span>
          </span>
        )}
        {hop.at === "certificate" && (
          <>
            <span className="flex flex-wrap items-baseline gap-x-2">
              <HopName object={hop.secret} />
              <CertificateLine read={hop.read} hosts={hop.hosts} />
            </span>
            {/* Core above, extension below, in that order and never the
                other way round: the hop reads whole with nothing installed. */}
            {issuance && (
              <RenewalNote issuance={issuance} secretName={hop.secret.name} />
            )}
          </>
        )}
        {hop.at === "controller" && (
          <Controller binding={hop.binding} brief={brief} />
        )}
        {hop.at === "stop" && <StopWords hop={hop} />}
      </div>
    </div>
  );
}

export function TrafficChain({
  query,
  certificates,
  issuance,
  controller,
}: {
  query: ConnectionsRead;
  /**
   * The certificates behind this Ingress's TLS Secrets, where the page has
   * read them. Absent, the chain draws exactly what it drew before — the
   * certificate hop is an addition and never a precondition.
   */
  certificates?: Map<string, TlsCertificate>;
  /** Why those certificates look the way they do, where anything can say. */
  issuance?: Issuance;
  /** Which controller claims this Ingress, where the page has resolved it. */
  controller?: IngressClassBinding;
}) {
  const t = useT();
  const { data, isPending, error } = query;

  // The three above are the Ingress page's, which has read them from its own
  // subject. Every other page gets the same three from here instead, so a
  // Deployment says which controller serves it and under what certificate
  // without five detail pages each wiring up four queries.
  const routed = useIngressRouting(data);

  // Built before the early returns rather than after them, because the hop
  // notes below are fetched with a hook and a hook may not sit behind a
  // condition. `trafficChains` is pure and answers an empty list for no data,
  // which is exactly what the hook should be asked about in that case.
  const paths = data
    ? trafficChains(data, t, {
        certificates: certificates ?? routed.certificates,
        controller,
        routing: routed.routing,
      })
    : [];
  const serviceHops = paths.flatMap((path) =>
    path.hops.flatMap((hop) =>
      hop.at === "object" && hop.object.kind === "Service"
        ? [{ namespace: hop.object.namespace ?? "", name: hop.object.name }]
        : []
    )
  );
  const unserved = unservedIngresses(paths);
  const edge = useServiceEdge(serviceHops);
  // The ways in a vendor's objects state — see `service.routes`.
  const routed2 = useServicesRoutes(serviceHops);

  if (isPending) {
    return (
      <p className="text-xs text-fg-fnt">{t("empty", "followingPathIn")}</p>
    );
  }
  if (error || !data) {
    // The same read the Connections tab escapes: this chain reads the one
    // `useConnections` query too, so a refusal offers the rule here as well,
    // not a bare red dead-end. See `ConnectionsPanel`.
    return (
      <Unknown
        question={t("empty", "couldNotReadWhatConnects")}
        error={error ?? t("empty", "clusterDidNotAnswer")}
        onRetry={() => void query.refetch()}
      />
    );
  }

  if (paths.length === 0) {
    if (closestSelector(data)) return <NearMissLine conns={data} />;
    const silence = chainSilence(data, t);
    // A quiet single line, and no heading over it: a heading plus one
    // sentence is two lines spent saying that nothing is there.
    return silence ? <p className="text-xs text-fg-fnt">{silence}</p> : null;
  }

  return (
    <Section>
      <SectionHeader
        title={t("nav", "howTrafficGetsHere")}
        count={
          paths.length > 1
            ? t("count", "servicesFrontThis", { n: paths.length })
            : undefined
        }
      />
      {/* A read that failed looks exactly like a chain still loading — no
          certificate hop, no controller hop, no address — unless something
          says so. The hops below are whatever could be read; this is what
          could not, so their gaps are not mistaken for answers. */}
      {routed.unread.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {routed.unread.map((unread) => (
            <p
              key={`${unread.ingress.namespace ?? ""}/${unread.ingress.name}/${unread.what}`}
              className="max-w-[92ch] text-[11px] text-warn"
            >
              {unread.what === "ingress"
                ? t("empty", "couldNotReadIngress", {
                    name: unread.ingress.name,
                  })
                : t("empty", "couldNotReadIngressController", {
                    name: unread.ingress.name,
                  })}
              <span className="block select-text wrap-break-word font-mono text-fg-mut">
                {unread.reason}
              </span>
            </p>
          ))}
        </div>
      )}
      {routed2.error && (
        <p className="max-w-[92ch] text-[11px] text-warn">
          {t("empty", "couldNotAskRoutes")}
          <span className="block select-text wrap-break-word font-mono text-fg-mut">
            {errorToShow(routed2.error)}
          </span>
        </p>
      )}
      {unserved && (
        <div
          className="flex max-w-[92ch] flex-col gap-0.5"
          data-testid="unserved-ingresses"
        >
          <p className="flex items-center gap-1.5 text-xs text-err">
            <CircleSlash className="h-3 w-3 flex-none" aria-hidden="true" />
            {t("count", "ingressesUnserved", {
              n: unserved.ingresses,
              classes: unserved.classes.join(", "),
            })}
          </p>
          <p className="pl-[18px] text-[11px] text-err/85">
            {t("empty", "nothingPickedThemUp")}{" "}
            {unserved.available.length > 0
              ? t("empty", "clusterHasClasses", {
                  list: unserved.available.join(", "),
                })
              : t("empty", "clusterHasNoIngressClass")}
          </p>
        </div>
      )}
      <div className="flex flex-col gap-4">
        {paths.map((path) => (
          <div key={path.key} className="flex flex-col">
            {path.hops.map((hop, index) => (
              <Hop
                key={index}
                hop={hop}
                next={path.hops[index + 1]}
                issuance={issuance ?? routed.issuance}
                edge={edge}
                routed={routed2}
                brief={unserved !== null}
              />
            ))}
          </div>
        ))}
      </div>
    </Section>
  );
}

/** A subject no Service selects, with the Service one label short of it named as a link. */
export function NearMissLine({ conns }: { conns: ResourceConnections }) {
  const t = useT();
  const closest = closestSelector(conns);
  if (!closest) return null;
  const service = closest.near.service;
  return (
    <p className="flex max-w-[92ch] items-baseline gap-1.5 text-xs text-fg-mut">
      <Unplug
        className="relative top-0.5 size-3 flex-none text-warn"
        aria-hidden
      />
      <span>
        {parts(nearMissWords(conns.subject, closest, t, "{service}"), {
          service: (
            <ResourceRef
              kind="Service"
              name={service.name}
              namespace={service.namespace}
              showKind={false}
            />
          ),
        })}
      </span>
    </p>
  );
}
