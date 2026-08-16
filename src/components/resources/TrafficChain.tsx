/**
 * How traffic gets here — and where it stops.
 *
 * On the Overview rather than behind a tab, because it is the first question
 * anybody asks about a running workload and the answer used to cost three
 * list pages and a squint at label selectors.
 *
 * The broken chain is the point. A view that only draws healthy topology is a
 * diagram; a view that says *where the path stops* is a tool. So a stop is a
 * hop of its own with a sentence a person can act on, and `noneReady` — pods
 * running, none of them ready — gets the loudest one, because it is the case
 * every list page in this app draws as healthy.
 *
 * Where there is nothing to draw the whole thing collapses to one line. A
 * Deployment with no Service in front of it must not cost a diagram to say so.
 */

import { Link } from "react-router-dom";

import { Section, SectionHeader } from "@/components/ui/section";
import {
  CopyableAddress,
  CopyableAddresses,
} from "@/components/ui/copyable-value";
import { useIngressRouting } from "@/hooks/useIngressRouting";
import { cn } from "@/lib/utils";
import { expiryOf } from "@/lib/certificates";
import { chainSilence, trafficChains, type ChainHop } from "@/lib/connections";
import type { ConnectionsQuery } from "@/hooks/useConnections";
import type { Issuance } from "@/hooks/useCertificateIssuance";
import {
  edgeKey,
  useServiceEdge,
  type ServiceEdges,
} from "@/hooks/useServiceEdge";
import {
  useServicesRoutes,
  type ServicesRoutes,
} from "@/hooks/useServiceRoutes";
import type { ServiceRoute } from "@/integrations";
import { CertificateLine } from "./CertificateFacts";
import { RenewalNote } from "./IssuanceChain";
import { ResourceRef } from "./ResourceRef";
import { ResourceName, RESOURCE_NAME_SHELL } from "./ResourceName";
import type {
  IngressClassBinding,
  ObjectRef,
  TlsCertificate,
} from "@/generated/types";

/**
 * A name at a hop. A missing object keeps its glyph and its hue and loses
 * only the link: the reader still has to recognise the name that is at
 * fault, and a link to a page that 404s is a second dead end.
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

type HopTone = "on" | "warn" | "bad";

const NODE_TONE: Record<HopTone, string> = {
  on: "border-fg bg-fg",
  warn: "border-warn",
  bad: "border-err",
};

function Rail({ tone, into }: { tone: HopTone; into: HopTone | null }) {
  return (
    <div className="flex flex-col items-center">
      <span
        aria-hidden="true"
        className={cn(
          "mt-[5px] h-[7px] w-[7px] flex-none rounded-full border-[1.5px]",
          NODE_TONE[tone]
        )}
      />
      {into && (
        <span
          aria-hidden="true"
          className={cn(
            "min-h-[14px] w-px flex-1",
            into === "bad" ? "bg-err/40" : "bg-hair"
          )}
        />
      )}
    </div>
  );
}

function toneOf(hop: ChainHop): HopTone {
  if (hop.at === "stop") return "bad";
  if (hop.at === "published") return hop.tone;
  if (hop.at === "controller") return hop.binding.resolved ? "on" : "bad";
  if (hop.at === "certificate") {
    // Not read back yet is not a finding; read back and unreadable is.
    if (!hop.read) return "on";
    if (!hop.read.certificate) return "warn";
    const tone = expiryOf(hop.read.certificate).tone;
    return tone === "err" ? "bad" : (tone ?? "on");
  }
  return "on";
}

/**
 * Who picks this Ingress up.
 *
 * The unmatched case is the one worth the width: correct YAML, no events,
 * no error, and nothing serving it. Naming the classes that do exist turns
 * "it does not work" into a one-word fix.
 */
function Controller({ binding }: { binding: IngressClassBinding }) {
  if (!binding.resolved) {
    return (
      <>
        <p className="text-xs text-err">
          {binding.requested
            ? `No IngressClass named ${binding.requested} in this cluster`
            : "This Ingress names no class, and this cluster has no default one"}
        </p>
        <p className="max-w-[92ch] text-[11px] text-err/85">
          Nothing has picked this Ingress up, so it has no address and never
          will until a controller for that class exists.
          {binding.available.length > 0
            ? ` This cluster has ${binding.available.map((c) => c.name).join(", ")}.`
            : " This cluster has no IngressClass at all."}
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
          serving class {binding.resolved}
          {binding.viaDefault ? ", this cluster's default" : ""}
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
 * Under the Service hop and never instead of it, the same order the renewal
 * note follows: the Service's own ports and selector are drawn first and stay
 * drawn, and this is a line added below them or nothing at all.
 *
 * The summary is stated as configuration, because that is what these objects
 * are. "health check HTTP :8080/healthz" is the probe the cloud will run —
 * not a claim that it passes, which no object in this cluster knows. Only
 * `problem` is allowed a colour, and only a supplier that read a real status
 * or a real missing object may set it.
 */
function EdgeNote({
  edge,
  object,
}: {
  edge: ServiceEdges | undefined;
  object: ObjectRef;
}) {
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
              to={config.source.to}
              className="font-mono text-info hover:underline"
            >
              {config.source.name}
            </Link>
          ) : (
            <span className="font-mono">{config.source.name}</span>
          )}{" "}
          {config.summary}
          {config.problem && (
            <span
              className={
                config.problem.tone === "err" ? "text-err" : "text-warn"
              }
            >
              {" — "}
              {config.problem.text}
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
function RoutesNote({ routes }: { routes: ServiceRoute[] | undefined }) {
  const vendors = (routes ?? []).filter(
    (route) => route.source.kind !== "Ingress"
  );
  if (vendors.length === 0) return null;
  const shown = vendors.slice(0, 6);

  return (
    <>
      {shown.map((route) => {
        const tail = route.path === "/" ? "" : route.path;
        const address =
          route.tls === null
            ? `${route.host}${tail}`
            : `${route.tls ? "https" : "http"}://${route.host}${tail}`;
        return (
          <p
            key={`${route.host}${route.path}`}
            className="text-[11px] text-fg-fnt"
          >
            <CopyableAddress value={address} label="Address" />
            {route.h2c ? " (gRPC)" : ""} — {route.source.kind}{" "}
            {route.to ? (
              <Link
                to={route.to}
                className="font-mono text-info hover:underline"
              >
                {route.source.name}
              </Link>
            ) : (
              <span className="font-mono">{route.source.name}</span>
            )}
          </p>
        );
      })}
      {vendors.length > shown.length && (
        <p className="text-[11px] text-fg-fnt">
          and {vendors.length - shown.length} more
        </p>
      )}
    </>
  );
}

function Hop({
  hop,
  next,
  issuance,
  edge,
  routed,
}: {
  hop: ChainHop;
  next: ChainHop | undefined;
  issuance: Issuance | undefined;
  edge: ServiceEdges | undefined;
  routed: ServicesRoutes | undefined;
}) {
  const last = next === undefined;
  return (
    <div className="grid grid-cols-[7px_minmax(0,1fr)] gap-x-2.5">
      {/* The run of line below a hop carries the colour of what comes next,
          so the segment leading into a stop is the part that turns red. */}
      <Rail tone={toneOf(hop)} into={next ? toneOf(next) : null} />
      <div className={cn("min-w-0", last ? "" : "pb-3")}>
        {hop.at === "object" && (
          <>
            <span className="flex flex-wrap items-baseline gap-x-2">
              {hop.self ? (
                <span className={RESOURCE_NAME_SHELL}>
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
              {hop.self && (
                <span className="text-[11px] text-fg-fnt">
                  — this {hop.object.kind}
                </span>
              )}
            </span>
            {hop.via && <p className="text-[11px] text-fg-fnt">{hop.via}</p>}
            {/* The address, on the clipboard. Everything above this hop is
                what the reader can read; this is the one line they can act
                on, and reconstructing it by hand from a host, a path and a
                guess at the scheme is exactly the errand this view exists to
                save. */}
            {hop.urls.length > 0 && (
              <p className="mt-0.5 text-[11px]">
                <CopyableAddresses values={hop.urls} label="Address" />
              </p>
            )}
            {/* And what that hostname has to resolve to. A URL on its own is
                only half an address on a cluster whose DNS nobody has pointed
                yet, which is most of them — this is the number you put in
                `--resolve` or in `/etc/hosts` to check the rest of the chain
                without waiting for a zone to propagate. */}
            {hop.publishedAt !== null &&
              (hop.publishedAt.length > 0 ? (
                <p className="text-[11px] text-fg-fnt">
                  at{" "}
                  <CopyableAddresses values={hop.publishedAt} label="Address" />
                </p>
              ) : (
                <p className="max-w-[92ch] text-[11px] text-warn">
                  No address yet — the controller has published none, so nothing
                  reaches this Ingress however its rules read.
                </p>
              ))}
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
              <span className="font-mono text-xs text-fg-mid">
                {hop.address}
              </span>
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
        {hop.at === "controller" && <Controller binding={hop.binding} />}
        {hop.at === "stop" && (
          <>
            <p className="text-xs text-err">{hop.title}</p>
            {/* A repair is a paragraph, and a paragraph set to the width of a
                1600px window is one nobody finishes reading. */}
            <p className="max-w-[92ch] text-[11px] text-err/85">{hop.note}</p>
          </>
        )}
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
  query: ConnectionsQuery;
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
    ? trafficChains(data, {
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
  const edge = useServiceEdge(serviceHops);
  // The ways in a vendor's objects state — see `service.routes`.
  const routed2 = useServicesRoutes(serviceHops);

  if (isPending) {
    return <p className="text-xs text-fg-fnt">Following the path in…</p>;
  }
  if (error || !data) {
    return (
      <p className="text-xs text-err">
        Could not read what connects to this: {error?.message ?? "no answer"}
      </p>
    );
  }

  if (paths.length === 0) {
    const silence = chainSilence(data);
    // A quiet single line, and no heading over it: a heading plus one
    // sentence is two lines spent saying that nothing is there.
    return silence ? <p className="text-xs text-fg-fnt">{silence}</p> : null;
  }

  return (
    <Section>
      <SectionHeader
        title="How traffic gets here"
        count={
          paths.length > 1 ? `${paths.length} Services front this` : undefined
        }
      />
      {/* A read that failed is not a chain that is still loading, and until
          this was drawn the two looked identical: no certificate hop, no
          controller hop, no address — forever, with nothing saying why. The
          hops below are still whatever could be read; this says what could
          not, so the gaps in them are not mistaken for answers. */}
      {routed.unread.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {routed.unread.map((unread) => (
            <p
              key={`${unread.ingress.namespace ?? ""}/${unread.ingress.name}/${unread.what}`}
              className="max-w-[92ch] text-[11px] text-warn"
            >
              {unread.what === "ingress"
                ? `Could not read Ingress ${unread.ingress.name}, so nothing below is complete for it`
                : `Could not read which controller serves Ingress ${unread.ingress.name}`}
              <span className="block select-text wrap-break-word font-mono text-fg-mut">
                {unread.reason}
              </span>
            </p>
          ))}
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
              />
            ))}
          </div>
        ))}
      </div>
    </Section>
  );
}
