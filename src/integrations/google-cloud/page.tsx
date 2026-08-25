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

import { Section, SectionHeader } from "@/components/ui/section";
import { ObjectLink, ResourceRef } from "@/components/resources/ResourceRef";
import { ResourceType } from "@/lib/resource-registry";
import { describeStop } from "@/lib/connections";
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
import { useT } from "@/i18n/useT";
import {
  BACKEND_CONFIG_CRD,
  FRONTEND_CONFIG_CRD,
  MANAGED_CERTIFICATE_CRD,
  backendConfigSummary,
  cdnOf,
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
  const t = useT();
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
          {t("empty", "couldNotReadIngresses")}
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
            : t("count", "hosts", { n: hosts.length })
        }
        description={t("empty", "gkeIngressHint")}
      />

      {sources.data?.unread.map((kind) => (
        <Finding
          key={kind.crd}
          tone="warn"
          title={
            <>
              <span className="font-mono">{kind.crd}</span>{" "}
              {t("empty", "couldNotBeListed")}
            </>
          }
          verbatim={kind.reason}
        >
          {t("empty", "unresolvedNotMissing")}
        </Finding>
      ))}

      {ignored.length > 0 && (
        <Finding tone="err" title={t("empty", "ingressesWrongClassField")}>
          {t("empty", "gkeReads")}{" "}
          <span className="font-mono">kubernetes.io/ingress.class</span>{" "}
          {t("empty", "gkeIgnores")}{" "}
          <span className="font-mono">spec.ingressClassName</span>
          {t("empty", "gkeClassFieldNote")}{" "}
          {ignored.map((ingress, index) => (
            <span key={`${ingress.namespace}/${ingress.name}`}>
              {index > 0 && ", "}
              <ResourceRef
                kind={ResourceType.Ingress}
                name={ingress.name}
                namespace={ingress.namespace}
                showKind={false}
                showNamespace
              />
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
            placeholder={t("action", "filterHostsPlaceholder")}
            label={t("action", "filterHosts")}
          />
        </div>

        {sources.isPending ? (
          <p className="text-xs text-fg-fnt">
            {t("empty", "readingIngresses")}
          </p>
        ) : hosts.length === 0 ? (
          <p className="max-w-[64ch] text-[11.5px] text-fg-mut">
            {t("empty", "noIngressCarries")}{" "}
            <span className="font-mono">kubernetes.io/ingress.class: gce</span>{" "}
            {t("empty", "orInline")}{" "}
            <span className="font-mono">gce-internal</span>
            {t("empty", "gkeControllerServesNothing")}
          </p>
        ) : shown.length === 0 ? (
          <p className="text-[11.5px] text-fg-fnt">
            {t("empty", "nothingMatches")}{" "}
            <span className="font-mono">{filter}</span>.
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
                alone={shown.length === 1}
              />
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}

/** The word at the right of a host line: what is true of it right now. */
function hostState(
  host: GkeHost,
  t: ReturnType<typeof useT>
): { text: string; tone: Tone } {
  if (host.findings.some((finding) => finding.kind === "stop")) {
    return { text: t("empty", "nothingBehindIt"), tone: "err" };
  }
  const certificate = host.findings.find(
    (finding) => finding.kind === "certificate" && finding.severity === "err"
  );
  if (certificate)
    return { text: t("empty", "certificateFailed"), tone: "err" };
  if (host.findings.some((finding) => finding.kind === "missing-object")) {
    return { text: t("empty", "namesSomethingAbsent"), tone: "err" };
  }
  if (host.findings.length > 0)
    return { text: t("empty", "worthALook"), tone: "warn" };
  return { text: t("empty", "serving"), tone: "ok" };
}

function HostRow({
  host,
  sources,
  openByDefault,
  last,
  alone,
}: {
  host: GkeHost;
  sources: GkeSources | null;
  openByDefault: boolean;
  last: boolean;
  /** The catch-all reads differently with nothing above it to match. */
  alone: boolean;
}) {
  const t = useT();
  const front = host.fronts[0];
  return (
    <TroubleRow
      title={
        host.host ?? (
          <span className="text-fg-mut">
            {alone ? t("empty", "everyHost") : t("empty", "anyHostNotMatched")}
          </span>
        )
      }
      copy={host.host ?? undefined}
      meta={
        <>
          {t("count", "paths", { n: host.routes.length })}
          {front && ` · ${front.class}`}
          {front && !front.allowsHttp && t("empty", "noHttpListener")}
        </>
      }
      state={hostState(host, t)}
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
  const t = useT();
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
              : t("empty", "noAddressYet")
          }
        >
          <ResourceRef
            kind={ResourceType.Ingress}
            name={front.ingress.name}
            namespace={front.ingress.namespace}
            showKind={false}
          />
        </Cell>
      </Column>
      <Column label={t("columns", "listeners")}>
        <Cell
          warn={!front.allowsHttp}
          under={
            front.staticIp
              ? t("empty", "staticIp", { ip: front.staticIp })
              : undefined
          }
        >
          {front.allowsHttp
            ? t("empty", "httpAndHttps")
            : t("empty", "httpsOnly")}
        </Cell>
      </Column>
      <Column label={t("columns", "frontend")}>
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
              <ObjectLink
                kind="FrontendConfig"
                name={front.frontendConfig.name}
                namespace={front.ingress.namespace}
                crd={FRONTEND_CONFIG_CRD}
                className="text-fg underline-offset-2 hover:underline"
              >
                {frontendConfigSummary(front.frontendConfig.found)}
              </ObjectLink>
            ) : (
              t("empty", "nameAbsent", { name: front.frontendConfig.name })
            )}
          </Cell>
        ) : (
          <Cell>
            <span className="text-fg-fnt">
              {t("empty", "noFrontendConfig")}
            </span>
          </Cell>
        )}
      </Column>
      <Column label={t("columns", "certificate")}>
        {certificates.length === 0 ? (
          <Cell warn>
            <span className="text-fg-fnt">
              {t("empty", "nothingTerminatesTls")}
            </span>
          </Cell>
        ) : (
          front.certificates.map((certificate) => (
            <Cell
              key={certificate.name}
              bad={certificateTone(certificate.status) === "err"}
              warn={certificateTone(certificate.status) === "warn"}
              under={certificate.status ?? t("empty", "noStatusYet")}
            >
              {certificate.found ? (
                <ResourceRef
                  kind="ManagedCertificate"
                  name={certificate.name}
                  namespace={front.ingress.namespace}
                  crd={MANAGED_CERTIFICATE_CRD}
                  showKind={false}
                />
              ) : (
                t("empty", "nameAbsent", { name: certificate.name })
              )}
            </Cell>
          ))
        )}
        {front.preShared.map((name) => (
          <Cell key={name} under={t("empty", "uploadedToGoogle")}>
            <span className="font-mono">{name}</span>
          </Cell>
        ))}
        {front.tlsSecrets.map((name) => (
          <Cell key={name} under={t("empty", "fromSpecTls")}>
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
  const t = useT();
  const backing = sources ? backingFor(route, sources) : null;
  return (
    <Chain>
      <Column label={t("columns", "path")}>
        <Cell under={route.pathType}>
          <span className="font-mono">{route.path}</span>
        </Cell>
      </Column>
      <Column label="Service">
        {route.backend ? (
          <Cell
            bad={backing?.stop !== null && backing?.stop !== undefined}
            under={
              route.neg
                ? t("empty", "containerNativeNeg")
                : t("empty", "throughKubeProxy")
            }
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
            {route.resourceBackend ?? t("empty", "noBackend")}
          </Cell>
        )}
      </Column>
      <Column label={t("columns", "backendConfig")}>
        {route.configs.length === 0 ? (
          <Cell>
            <span className="text-fg-fnt">{t("empty", "gkeDefaults")}</span>
          </Cell>
        ) : (
          route.configs.map((config) => (
            <Cell
              key={`${config.name}/${config.port ?? "default"}`}
              bad={!config.found}
              under={
                config.port === null
                  ? t("empty", "everyPort")
                  : t("empty", "portNumber", { port: config.port })
              }
              title={
                config.found
                  ? `${config.name} — ${backendConfigSummary(config.found)}`
                  : undefined
              }
            >
              {config.found ? (
                <ObjectLink
                  kind="BackendConfig"
                  name={config.name}
                  namespace={route.ingress.namespace}
                  crd={BACKEND_CONFIG_CRD}
                  className="text-fg underline-offset-2 hover:underline"
                >
                  {backendConfigSummary(config.found, { cdn: false })}
                </ObjectLink>
              ) : (
                t("empty", "nameAbsent", { name: config.name })
              )}
            </Cell>
          ))
        )}
      </Column>
      {/* Its own hop, not a clause mid-line: the edge cache is the one
          switch here that answers requests *instead of* the backend, and a
          deployed fix hides behind it for `defaultTtl` seconds. */}
      {route.configs.some(
        (config) => config.found && cdnOf(config.found) !== null
      ) && (
        <Column label={t("columns", "edgeCache")}>
          {route.configs.map((config) => {
            const cdn = config.found ? cdnOf(config.found) : null;
            if (!cdn) return null;
            return (
              <Cell key={config.name} under={cdn.detail ?? undefined}>
                <span className="font-mono">{cdn.mode ?? "on"}</span>
              </Cell>
            );
          })}
        </Column>
      )}
      <Column label={t("columns", "takenOutAfter")}>
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
                <span className="text-fg-fnt">{t("empty", "gkeDefaults")}</span>
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
  const t = useT();
  switch (finding.kind) {
    case "missing-object":
      return (
        <Finding
          tone="err"
          title={
            <>
              {t("empty", "noWord")}{" "}
              <span className="font-mono">{finding.what}</span>{" "}
              {t("empty", "namedWord")}{" "}
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
              <span className="font-mono">{finding.domain.domain}</span>{" "}
              {t("empty", "certificateIs")} {finding.domain.status}
            </>
          }
        >
          {finding.domain.status === "FailedNotVisible"
            ? t("empty", "certFailedNotVisible", {
                domain: finding.domain.domain,
                certificate: finding.certificate,
              })
            : t("empty", "certProvisioningNote", {
                certificate: finding.certificate,
              })}
        </Finding>
      );
    case "wildcard":
      return (
        <Finding
          tone="err"
          title={
            <>
              <span className="font-mono">{finding.certificate}</span>{" "}
              {t("empty", "asksForWildcard")}
            </>
          }
        >
          {t("empty", "wildcardNotePrefix")}{" "}
          <span className="font-mono">{finding.domain}</span>
          {t("empty", "wildcardNoteSuffix")}
        </Finding>
      );
    case "domain-unserved":
      return (
        <Finding
          tone="warn"
          title={
            <>
              <span className="font-mono">{finding.certificate}</span>{" "}
              {t("empty", "coversUnservedDomain")}
            </>
          }
        >
          <span className="font-mono">{finding.domain}</span>{" "}
          {t("empty", "domainUnservedMid")}{" "}
          <span className="font-mono">spec.domains</span>{" "}
          {t("empty", "domainUnservedSuffix")}
        </Finding>
      );
    case "no-tls":
      return (
        <Finding
          tone="warn"
          title={
            <>
              <span className="font-mono">{finding.ingress}</span>{" "}
              {t("empty", "answersOnNothing")}
            </>
          }
        >
          {t("empty", "httpListenerOffPrefix")}{" "}
          <span className="font-mono">
            kubernetes.io/ingress.allow-http: false
          </span>{" "}
          {t("empty", "httpListenerOffSuffix")}
        </Finding>
      );
    case "stop": {
      // The app's own words for a stop, not the enum on the wire: `reason` is
      // `selectsNothing`, and printing that told the reader nothing they
      // could act on.
      const stop = finding.backing.stop
        ? describeStop(finding.backing.stop, t)
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
