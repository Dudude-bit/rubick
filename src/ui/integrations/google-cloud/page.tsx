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

import { joinSayings } from "@/i18n/say";
import { useMemo } from "react";

import { Section, SectionHeader } from "@/components/ui/section";
import { ObjectLink, ResourceRef } from "@/components/resources/ResourceRef";
import { ShareScreenAction } from "@/components/share/ShareAction";
import { ResourceType } from "@/lib/resource-registry";
import { describeStop } from "@/lib/connections";
import { refOf } from "@/lib/report-parts";
import {
  Cell,
  Chain,
  Column,
  Finding,
  BackingUnread,
  TroubleList,
  TroubleRow,
  VendorReadFailure,
} from "../page-kit";
import { backingFrom } from "../ingress";
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
  hostState,
  hostsOf,
  ignoredByClassName,
  severityOfHost,
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

  const joined = useMemo<GkeSources | null>(() => {
    if (!sources.data) return null;
    return {
      ...sources.data,
      ...backingFrom(backing.data, backing.error),
    };
  }, [sources.data, backing.data, backing.error]);

  const hosts = useMemo(() => (joined ? hostsOf(joined) : []), [joined]);
  const ignored = useMemo(
    () => (sources.data ? ignoredByClassName(sources.data.ingresses) : []),
    [sources.data]
  );

  if (sources.error) {
    return (
      <VendorReadFailure
        title={t("empty", "couldNotReadIngresses")}
        error={sources.error}
        onRetry={() => void sources.refetch()}
      />
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
        actions={<ShareScreenAction screen={{ title: "GKE Ingress" }} />}
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
        ) : (
          <TroubleList
            items={hosts}
            severityOf={severityOfHost}
            searchable={searchableHost}
            filter={{
              placeholder: t("action", "filterHostsPlaceholder"),
              label: t("action", "filterHosts"),
            }}
            autoOpen={{ when: "err", upTo: AUTO_OPEN }}
            noMatch={(query) => t("empty", "nothingMatchesQuery", { query })}
            aside={
              <>
                {backing.isPending && (
                  <span className="text-[11px] text-fg-fnt">
                    {t("empty", "checkingWhatIsBehind")}
                  </span>
                )}
                <BackingUnread error={joined?.backingError ?? null} />
              </>
            }
            keyOf={(host, index) => host.host ?? `catch-all-${index}`}
            renderRow={(host, { openByDefault, last, shown }) => (
              <HostRow
                host={host}
                sources={joined}
                openByDefault={openByDefault}
                last={last}
                alone={shown === 1}
              />
            )}
            share={{
              title: "Hosts",
              toFinding: (host) => {
                const severity = severityOfHost(host);
                if (severity === null) return null;
                const state = hostState(host, joined?.backingError ?? null, t);
                return {
                  title: host.host ?? "(unmatched host)",
                  detail: state.text,
                  role: severity === "unknown" ? "neutral" : severity,
                  ref:
                    host.fronts.length === 1
                      ? refOf({
                          kind: ResourceType.Ingress,
                          name: host.fronts[0].ingress.name,
                          namespace: host.fronts[0].ingress.namespace,
                        })
                      : undefined,
                };
              },
            }}
          />
        )}
      </Section>
    </div>
  );
}

const searchableHost = (host: GkeHost) => [
  host.host,
  ...host.routes.flatMap((route) => [route.backend?.name, route.ingress.name]),
];

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
      state={hostState(host, sources?.backingError ?? null, t)}
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
            bad={front.frontendConfig.known && !front.frontendConfig.found}
            title={
              front.frontendConfig.found
                ? joinSayings(
                    frontendConfigSummary(front.frontendConfig.found),
                    t
                  )
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
                {joinSayings(
                  frontendConfigSummary(front.frontendConfig.found),
                  t
                )}
              </ObjectLink>
            ) : (
              t(
                "empty",
                front.frontendConfig.known ? "nameAbsent" : "nameUnread",
                { name: front.frontendConfig.name }
              )
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
              under={
                certificate.found
                  ? (certificate.status ?? t("empty", "noStatusYet"))
                  : undefined
              }
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
                t("empty", certificate.known ? "nameAbsent" : "nameUnread", {
                  name: certificate.name,
                })
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
              !backing?.known
                ? t(
                    "empty",
                    backing?.error ? "endpointsUnread" : "readingEndpoints"
                  )
                : route.neg
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
            <span className="text-fg-fnt">
              {route.backend && !backing?.known
                ? t("empty", "notReadLower")
                : t("empty", "gkeDefaults")}
            </span>
          </Cell>
        ) : (
          route.configs.map((config) => (
            <Cell
              key={`${config.name}/${config.port ?? "default"}`}
              bad={config.known && !config.found}
              under={
                config.port === null
                  ? t("empty", "everyPort")
                  : t("empty", "portNumber", { port: config.port })
              }
              title={
                config.found
                  ? `${config.name} — ${joinSayings(
                      backendConfigSummary(config.found),
                      t
                    )}`
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
                  {joinSayings(
                    backendConfigSummary(config.found, { cdn: false }),
                    t
                  )}
                </ObjectLink>
              ) : (
                t("empty", config.known ? "nameAbsent" : "nameUnread", {
                  name: config.name,
                })
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
