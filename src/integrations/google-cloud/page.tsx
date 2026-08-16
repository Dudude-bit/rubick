/**
 * GKE Ingress: what each hostname is terminated by, and what answers it.
 *
 * The same pivot Traefik's and nginx's pages use, and for the same reason —
 * the question is *what serves this hostname and why is this URL not
 * working*. What is GKE's own is that both halves of the answer live in
 * objects joined to the Ingress by **annotations**, so neither the Ingress
 * page nor the three CRD list pages can show them together. See
 * `./routes.ts` for the four edges.
 *
 * ## Nothing here reports health it was not told
 *
 * `BackendConfig` and `FrontendConfig` carry no status at all. Every state
 * on this page is either a *missing object* — a name that resolves to
 * nothing, which is a real and silent GKE failure — or a status a controller
 * actually wrote, which for this stack means `ManagedCertificate` and
 * nothing else. Whether Google's load balancer is passing the health check
 * this page prints is a question for the Compute API, one credential up, and
 * asserting it from anything in the cluster would be a guess wearing a
 * verdict's clothes.
 */

import { useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { Section, SectionHeader } from "@/components/ui/section";
import { ResourceRef } from "@/components/resources/ResourceRef";
import { ResourceType } from "@/lib/resource-registry";
import { getResourceDetailUrl } from "@/lib/navigation-utils";
import { describeStop } from "@/lib/connections";
import { crdObjectPath } from "../kit";
import {
  Cell,
  Chain,
  Column,
  FilterBox,
  Finding,
  TroubleRow,
  type Tone,
} from "../page-kit";
import { useBacking, useIngressSources } from "./data";
import {
  BACKEND_CONFIG_CRD,
  FRONTEND_CONFIG_CRD,
  MANAGED_CERTIFICATE_CRD,
  backendConfigSummary,
  certificateTone,
  frontendConfigSummary,
  healthCheckTiming,
} from "./model";
import {
  backingFor,
  hostsOf,
  ignoredByClassName,
  type GkeFinding,
  type GkeFront,
  type GkeHost,
  type GkeRoute,
  type GkeSources,
} from "./routes";

/** Past this many broken hosts, nothing opens itself. */
const AUTO_OPEN = 8;

export default function GkeIngressPage() {
  const sources = useIngressSources();
  const backing = useBacking();
  const [filter, setFilter] = useState("");

  const joined = useMemo<GkeSources | null>(() => {
    if (!sources.data) return null;
    return {
      ...sources.data,
      services: backing.data?.services ?? [],
      published: backing.data?.published ?? [],
      backingKnown: backing.data !== undefined,
    };
  }, [sources.data, backing.data]);

  const hosts = useMemo(() => (joined ? hostsOf(joined) : []), [joined]);
  const ignored = useMemo(
    () => (sources.data ? ignoredByClassName(sources.data.ingresses) : []),
    [sources.data]
  );

  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (needle === "") return hosts;
    return hosts.filter(
      (host) =>
        (host.host ?? "").toLowerCase().includes(needle) ||
        host.routes.some(
          (route) =>
            route.backend?.name.toLowerCase().includes(needle) ||
            route.ingress.name.toLowerCase().includes(needle)
        )
    );
  }, [hosts, filter]);

  const broken = hosts.filter((host) => host.worst === "err").length;

  if (sources.error) {
    return (
      <Section className="max-w-[64ch] py-8">
        <h2 className="text-[13px] font-semibold tracking-tight text-err">
          Could not read this cluster&rsquo;s Ingresses
        </h2>
        <p className="text-[11px] text-fg-fnt">{sources.error.message}</p>
      </Section>
    );
  }

  return (
    <div className="flex flex-col gap-[22px]">
      <SectionHeader
        title="GKE Ingress"
        count={
          sources.isPending
            ? undefined
            : `${hosts.length} ${hosts.length === 1 ? "host" : "hosts"}`
        }
        description="Every hostname this cluster's Google load balancers serve — what terminates it, and what answers behind it."
      />

      {sources.data?.unread.map((kind) => (
        <Finding
          key={kind.crd}
          tone="warn"
          title={
            <>
              <span className="font-mono">{kind.crd}</span> could not be listed
            </>
          }
          verbatim={kind.reason}
        >
          Anything below that names one is shown as unresolved rather than as
          missing — the two are not the same and only one of them is a fault in
          the cluster.
        </Finding>
      ))}

      {ignored.length > 0 && (
        <Finding
          tone="err"
          title="Ingresses asking for GKE the way GKE does not read"
        >
          GKE reads{" "}
          <span className="font-mono">kubernetes.io/ingress.class</span> and
          ignores <span className="font-mono">spec.ingressClassName</span>.
          These name a GKE class in the field Kubernetes documents, carry no
          annotation, and are served by nothing at all — correct YAML, no
          events, no error:{" "}
          {ignored.map((ingress, index) => (
            <span key={`${ingress.namespace}/${ingress.name}`}>
              {index > 0 && ", "}
              <Link
                className="font-mono text-fg underline-offset-2 hover:underline"
                to={getResourceDetailUrl(
                  ResourceType.Ingress,
                  ingress.name,
                  ingress.namespace
                )}
              >
                {ingress.namespace}/{ingress.name}
              </Link>
            </span>
          ))}
          .
        </Finding>
      )}

      <Section>
        <div className="mb-3 flex items-center justify-between gap-3">
          <FilterBox
            value={filter}
            onChange={setFilter}
            placeholder="Filter by host or Service…"
            label="Filter hosts"
          />
        </div>

        {sources.isPending ? (
          <p className="text-xs text-fg-fnt">Reading the Ingresses…</p>
        ) : hosts.length === 0 ? (
          <p className="max-w-[64ch] text-[11.5px] text-fg-mut">
            No Ingress in this cluster carries{" "}
            <span className="font-mono">kubernetes.io/ingress.class: gce</span>{" "}
            or <span className="font-mono">gce-internal</span>, so GKE&rsquo;s
            controller is serving nothing here. The CRDs it owns may still be
            installed — that is what put this page in the sidebar.
          </p>
        ) : shown.length === 0 ? (
          <p className="text-[11.5px] text-fg-fnt">
            Nothing matches <span className="font-mono">{filter}</span>.
          </p>
        ) : (
          <div className="flex flex-col">
            {shown.map((host, index) => (
              <HostRow
                key={host.host ?? `catch-all-${index}`}
                host={host}
                sources={joined}
                openByDefault={host.worst === "err" && broken <= AUTO_OPEN}
                last={index === shown.length - 1}
              />
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}

/** The word at the right of a host line: what is true of it right now. */
function hostState(host: GkeHost): { text: string; tone: Tone } {
  if (host.findings.some((finding) => finding.kind === "stop")) {
    return { text: "nothing behind it", tone: "err" };
  }
  const certificate = host.findings.find(
    (finding) => finding.kind === "certificate" && finding.severity === "err"
  );
  if (certificate) return { text: "certificate failed", tone: "err" };
  if (host.findings.some((finding) => finding.kind === "missing-object")) {
    return { text: "names something absent", tone: "err" };
  }
  if (host.findings.length > 0) return { text: "worth a look", tone: "warn" };
  return { text: "serving", tone: "ok" };
}

function HostRow({
  host,
  sources,
  openByDefault,
  last,
}: {
  host: GkeHost;
  sources: GkeSources | null;
  openByDefault: boolean;
  last: boolean;
}) {
  const front = host.fronts[0];
  return (
    <TroubleRow
      title={
        host.host ?? (
          <span className="text-fg-mut">any host not matched above</span>
        )
      }
      meta={
        <>
          {host.routes.length} {host.routes.length === 1 ? "path" : "paths"}
          {front && ` · ${front.class}`}
          {front && !front.allowsHttp && " · no HTTP listener"}
        </>
      }
      state={hostState(host)}
      openByDefault={openByDefault}
      last={last}
    >
      <div className="flex flex-col gap-3">
        {host.fronts.map((entry) => (
          <FrontBlock
            key={`${entry.ingress.namespace}/${entry.ingress.name}`}
            front={entry}
          />
        ))}
        {host.routes.map((route) => (
          <RouteChain key={route.key} route={route} sources={sources} />
        ))}
        {host.findings.map((finding, index) => (
          <FindingLine key={index} finding={finding} />
        ))}
      </div>
    </TroubleRow>
  );
}

/** What terminates the host, before anything looks at a backend. */
function FrontBlock({ front }: { front: GkeFront }) {
  const certificates = [
    ...front.certificates.map((certificate) => certificate.name),
    ...front.preShared.map((name) => `${name} (pre-shared)`),
    ...front.tlsSecrets.map((name) => `${name} (Secret)`),
  ];
  return (
    <Chain>
      <Column label="Ingress">
        <Cell
          under={
            front.addresses.length > 0
              ? front.addresses.join(", ")
              : "no address yet"
          }
        >
          <Link
            className="font-mono text-fg underline-offset-2 hover:underline"
            to={getResourceDetailUrl(
              ResourceType.Ingress,
              front.ingress.name,
              front.ingress.namespace
            )}
          >
            {front.ingress.name}
          </Link>
        </Cell>
      </Column>
      <Column label="Listeners">
        <Cell
          warn={!front.allowsHttp}
          under={front.staticIp ? `static IP ${front.staticIp}` : undefined}
        >
          {front.allowsHttp ? "HTTP and HTTPS" : "HTTPS only"}
        </Cell>
      </Column>
      <Column label="Frontend">
        {front.frontendConfig ? (
          <Cell
            bad={!front.frontendConfig.found}
            title={
              front.frontendConfig.found
                ? frontendConfigSummary(front.frontendConfig.found)
                : undefined
            }
          >
            {front.frontendConfig.found ? (
              <Link
                className="font-mono text-fg underline-offset-2 hover:underline"
                to={crdObjectPath(
                  FRONTEND_CONFIG_CRD,
                  front.ingress.namespace,
                  front.frontendConfig.name
                )}
              >
                {frontendConfigSummary(front.frontendConfig.found)}
              </Link>
            ) : (
              `${front.frontendConfig.name} — absent`
            )}
          </Cell>
        ) : (
          <Cell>
            <span className="text-fg-fnt">no FrontendConfig</span>
          </Cell>
        )}
      </Column>
      <Column label="Certificate">
        {certificates.length === 0 ? (
          <Cell warn>
            <span className="text-fg-fnt">nothing terminates TLS</span>
          </Cell>
        ) : (
          front.certificates.map((certificate) => (
            <Cell
              key={certificate.name}
              bad={certificateTone(certificate.status) === "err"}
              warn={certificateTone(certificate.status) === "warn"}
              under={certificate.status ?? "no status yet"}
            >
              {certificate.found ? (
                <Link
                  className="font-mono text-fg underline-offset-2 hover:underline"
                  to={crdObjectPath(
                    MANAGED_CERTIFICATE_CRD,
                    front.ingress.namespace,
                    certificate.name
                  )}
                >
                  {certificate.name}
                </Link>
              ) : (
                `${certificate.name} — absent`
              )}
            </Cell>
          ))
        )}
        {front.preShared.map((name) => (
          <Cell key={name} under="uploaded to Google, not in this cluster">
            <span className="font-mono">{name}</span>
          </Cell>
        ))}
        {front.tlsSecrets.map((name) => (
          <Cell key={name} under="from spec.tls">
            <span className="font-mono">{name}</span>
          </Cell>
        ))}
      </Column>
    </Chain>
  );
}

/** One path, and everything the backend behind it was told. */
function RouteChain({
  route,
  sources,
}: {
  route: GkeRoute;
  sources: GkeSources | null;
}) {
  const backing = sources ? backingFor(route, sources) : null;
  return (
    <Chain>
      <Column label="Path">
        <Cell under={route.pathType}>
          <span className="font-mono">{route.path}</span>
        </Cell>
      </Column>
      <Column label="Service">
        {route.backend ? (
          <Cell
            bad={backing?.stop !== null && backing?.stop !== undefined}
            under={route.neg ? "container-native (NEG)" : "through kube-proxy"}
          >
            <ResourceRef
              kind={ResourceType.Service}
              name={route.backend.name}
              namespace={route.ingress.namespace}
              showKind={false}
            />
          </Cell>
        ) : (
          <Cell bad={route.resourceBackend === null}>
            {route.resourceBackend ?? "no backend"}
          </Cell>
        )}
      </Column>
      <Column label="Backend config">
        {route.configs.length === 0 ? (
          <Cell>
            <span className="text-fg-fnt">GKE defaults</span>
          </Cell>
        ) : (
          route.configs.map((config) => (
            <Cell
              key={`${config.name}/${config.port ?? "default"}`}
              bad={!config.found}
              under={
                config.port === null ? "every port" : `port ${config.port}`
              }
              title={
                config.found
                  ? `${config.name} — ${backendConfigSummary(config.found)}`
                  : undefined
              }
            >
              {config.found ? (
                <Link
                  className="text-fg underline-offset-2 hover:underline"
                  to={crdObjectPath(
                    BACKEND_CONFIG_CRD,
                    route.ingress.namespace,
                    config.name
                  )}
                >
                  {backendConfigSummary(config.found)}
                </Link>
              ) : (
                `${config.name} — absent`
              )}
            </Cell>
          ))
        )}
      </Column>
      <Column label="Taken out after">
        {route.configs.map((config) => {
          if (!config.found) return null;
          const timing = healthCheckTiming(config.found);
          // Both halves or neither: "every 5s" without a threshold does not
          // answer how long a bad backend keeps taking traffic, and the
          // defaults GKE fills in are not this object's to state.
          const stated =
            timing.intervalSec !== null && timing.unhealthyThreshold !== null;
          return (
            <Cell
              key={config.name}
              under={
                stated
                  ? `${timing.intervalSec}s × ${timing.unhealthyThreshold}`
                  : undefined
              }
            >
              {stated ? (
                `${timing.intervalSec! * timing.unhealthyThreshold!}s`
              ) : (
                <span className="text-fg-fnt">GKE defaults</span>
              )}
            </Cell>
          );
        })}
        {route.configs.length === 0 && (
          <Cell>
            <span className="text-fg-fnt">—</span>
          </Cell>
        )}
      </Column>
    </Chain>
  );
}

function FindingLine({ finding }: { finding: GkeFinding }) {
  switch (finding.kind) {
    case "missing-object":
      return (
        <Finding
          tone="err"
          title={
            <>
              No <span className="font-mono">{finding.what}</span> named{" "}
              <span className="font-mono">{finding.name}</span>
            </>
          }
        >
          {finding.why}.
        </Finding>
      );
    case "certificate":
      return (
        <Finding
          tone={finding.severity}
          title={
            <>
              <span className="font-mono">{finding.domain.domain}</span> is{" "}
              {finding.domain.status}
            </>
          }
        >
          {finding.domain.status === "FailedNotVisible"
            ? `Google could not reach ${finding.domain.domain} at this load balancer, which is almost always DNS that does not point here yet. It stays this way until something changes — ${finding.certificate} will not retry its way out of it.`
            : `From ${finding.certificate}. Provisioning is a wait rather than a fault; anything beginning Failed is a stop.`}
        </Finding>
      );
    case "wildcard":
      return (
        <Finding
          tone="err"
          title={
            <>
              <span className="font-mono">{finding.certificate}</span> asks for
              a wildcard, which Google will not issue
            </>
          }
        >
          Google-managed certificates do not support wildcard domains at all —
          up to a hundred names, every one of them literal. The API server
          accepted <span className="font-mono">{finding.domain}</span>, Google
          never issues it, and the object reports it as ordinary provisioning
          for ever. A wildcard needs a self-managed certificate here, or the
          Gateway API with Certificate Manager.
        </Finding>
      );
    case "domain-unserved":
      return (
        <Finding
          tone="warn"
          title={
            <>
              <span className="font-mono">{finding.certificate}</span> covers a
              domain this Ingress does not serve
            </>
          }
        >
          <span className="font-mono">{finding.domain}</span> is in the
          certificate&rsquo;s <span className="font-mono">spec.domains</span>{" "}
          and in none of this Ingress&rsquo;s rules. Google provisions a domain
          by reaching this load balancer at that name, and nothing here answers
          to it — so the whole certificate sits unissued for a domain nobody
          meant to serve.
        </Finding>
      );
    case "no-tls":
      return (
        <Finding
          tone="warn"
          title={
            <>
              <span className="font-mono">{finding.ingress}</span> answers on
              nothing
            </>
          }
        >
          Its HTTP listener is switched off with{" "}
          <span className="font-mono">
            kubernetes.io/ingress.allow-http: false
          </span>{" "}
          and it names no certificate of any kind, so GKE builds neither
          listener.
        </Finding>
      );
    case "stop": {
      // The app's own words for a stop, not the enum on the wire: `reason` is
      // `selectsNothing`, and printing that told the reader nothing they
      // could act on.
      const stop = finding.backing.stop
        ? describeStop(finding.backing.stop)
        : null;
      if (!stop) return null;
      return (
        <Finding tone="err" title={stop.title}>
          {stop.note}
        </Finding>
      );
    }
    default:
      return null;
  }
}
