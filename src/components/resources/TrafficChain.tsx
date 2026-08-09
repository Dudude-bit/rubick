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

import { Section, SectionHeader } from "@/components/ui/section";
import { cn } from "@/lib/utils";
import { expiryOf } from "@/lib/certificates";
import { chainSilence, trafficChains, type ChainHop } from "@/lib/connections";
import type { ConnectionsQuery } from "@/hooks/useConnections";
import type { Issuance } from "@/hooks/useCertificateIssuance";
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
        <p className="text-[11px] text-err/85">
          Nothing has picked this Ingress up, so it has no address and never
          will until a controller for that class exists.
          {binding.available.length > 0
            ? ` This cluster has ${binding.available.join(", ")}.`
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

function Hop({
  hop,
  next,
  issuance,
}: {
  hop: ChainHop;
  next: ChainHop | undefined;
  issuance: Issuance | undefined;
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
          </>
        )}
        {hop.at === "pods" && (
          <span className="flex flex-wrap items-baseline gap-x-2">
            <HopName object={hop.pods[0]} />
            <span className="text-[11px] text-fg-fnt">{hop.summary}</span>
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
            <p className="text-[11px] text-err/85">{hop.note}</p>
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

  const paths = trafficChains(data, { certificates, controller });
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
      <div className="flex flex-col gap-4">
        {paths.map((path) => (
          <div key={path.key} className="flex flex-col">
            {path.hops.map((hop, index) => (
              <Hop
                key={index}
                hop={hop}
                next={path.hops[index + 1]}
                issuance={issuance}
              />
            ))}
          </div>
        ))}
      </div>
    </Section>
  );
}
