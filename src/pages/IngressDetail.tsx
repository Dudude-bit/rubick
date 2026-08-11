import { useQuery } from "@tanstack/react-query";
import { Copy, ExternalLink, Info, Lock, Route, Tag } from "lucide-react";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Section, SectionHeader } from "@/components/ui/section";
import { Skeleton } from "@/components/ui/skeleton";
import { CopyableAddresses } from "@/components/ui/copyable-value";
import { yamlTab } from "@/components/resources/yaml-tab";
import { ResourceDetailLayout } from "@/components/resources/ResourceDetailLayout";
import {
  countMark,
  kindGlyph,
  viewGlyph,
} from "@/components/resources/detail-tab";
import { DetailAction, EventRows } from "@/components/resources/detail-blocks";
import { ResourceRef } from "@/components/resources/ResourceRef";
import {
  KeyValueList,
  KeyValueSection,
  type KeyValue,
} from "@/components/resources/detail-kv";
import {
  recordToKeyValues,
  TONE_CLASS,
} from "@/components/resources/key-values";
import { CertificateLine } from "@/components/resources/CertificateFacts";
import { IssuanceSection } from "@/components/resources/IssuanceChain";
import { TrafficChain } from "@/components/resources/TrafficChain";
import { connectionsTab } from "@/components/resources/connections-tab";
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";
import { useResourceDetail } from "@/hooks";
import { useConnections } from "@/hooks/useConnections";
import { useCertificateIssuance } from "@/hooks/useCertificateIssuance";
import { useTlsCertificates } from "@/hooks/useTlsCertificates";
import { expiryOf } from "@/lib/certificates";
import { deliveryOfKind } from "@/lib/delivery";
import { commands } from "@/lib/commands";
import { normalizeTauriError } from "@/lib/error-utils";
import { REFRESH_INTERVALS } from "@/lib/refresh";
import { ResourceType } from "@/lib/resource-registry";
import { cn } from "@/lib/utils";
import type { EventFilters, IngressInfo, IngressRule } from "@/generated/types";

interface AccessUrl {
  fullUrl: string;
  host: string;
  displayHost: string;
  path: string;
  backendService: string;
  backendPort: string;
  resourceBackend: string | null;
  isHttps: boolean;
  /** `true` when TLS covers the host only through a catch-all entry. */
  viaCatchAll: boolean;
}

function generateAccessUrls(
  rules: IngressRule[],
  tlsHosts: string[],
  hasCatchAllTls: boolean
): AccessUrl[] {
  const urls: AccessUrl[] = [];

  for (const rule of rules) {
    const isWildcard = rule.host === "*" || !rule.host;
    const explicit = tlsHosts.includes(rule.host);
    const isHttps = explicit || hasCatchAllTls;
    const scheme = isHttps ? "https" : "http";
    const actualHost = isWildcard ? "" : rule.host;

    for (const path of rule.paths) {
      urls.push({
        fullUrl: actualHost
          ? `${scheme}://${actualHost}${path.path}`
          : `${scheme}://<host>${path.path}`,
        host: rule.host,
        displayHost: isWildcard ? "All hosts" : rule.host,
        path: path.path,
        backendService: path.backendService,
        backendPort: path.backendPort,
        resourceBackend: path.resourceBackend,
        isHttps,
        viaCatchAll: isHttps && !explicit,
      });
    }
  }

  return urls;
}

/** "1 host", "2 hosts" — the count and its noun agree. */
function countOf(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

const ACCESS_ROW =
  "grid grid-cols-[44px_minmax(0,1fr)_minmax(0,190px)_50px] items-baseline gap-2.5 px-1.5 py-[3px] text-xs";

function IconAction({
  label,
  icon: Icon,
  onClick,
}: {
  label: string;
  icon: typeof Copy;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="flex h-5 w-5 items-center justify-center rounded text-fg-fnt transition-colors hover:bg-hover hover:text-fg"
    >
      <Icon className="h-3.5 w-3.5" />
    </button>
  );
}

export function IngressDetail() {
  const copyToClipboard = useCopyToClipboard();
  const {
    name,
    namespace,
    resource: ingress,
    isLoading,
    error,
    yaml: ingressYaml,
    copyYaml,
    activeTab,
    setActiveTab,
    goBack,
  } = useResourceDetail<IngressInfo>({
    resourceKind: ResourceType.Ingress,
    fetchResource: async (name, ns) => {
      try {
        return await commands.getIngress(name, ns);
      } catch (err) {
        throw new Error(normalizeTauriError(err), { cause: err });
      }
    },
    deleteResource: async (name, ns) => {
      try {
        await commands.deleteIngress(name, ns);
      } catch (err) {
        throw new Error(normalizeTauriError(err), { cause: err });
      }
    },
    defaultTab: "overview",
  });

  const rules = ingress?.rules ?? [];
  const tlsHosts = ingress?.tlsHosts ?? [];
  const tlsConfigs = ingress?.tlsConfigs ?? [];
  const loadBalancerIps = ingress?.loadBalancerIps ?? [];
  const hasCatchAllTls = ingress?.hasCatchAllTls ?? false;
  const accessUrls = generateAccessUrls(rules, tlsHosts, hasCatchAllTls);
  const hasTls = tlsHosts.length > 0 || tlsConfigs.length > 0;
  const plainHttp = accessUrls.filter((url) => !url.isHttps).length;

  const connections = useConnections(ResourceType.Ingress, name, namespace);
  const tlsSecretNames = tlsConfigs.flatMap((config) =>
    config.secretName ? [config.secretName] : []
  );
  const certificates = useTlsCertificates(
    ingress?.namespace ?? namespace,
    tlsSecretNames
  );
  const issuance = useCertificateIssuance(
    ingress?.namespace ?? namespace,
    tlsSecretNames
  );

  // Which controller claims this Ingress. Core: IngressClass is a built-in
  // kind, and "none does" is the failure that is silent everywhere else.
  const { data: controller } = useQuery({
    queryKey: ["ingress-class", ingress?.className ?? null],
    queryFn: () => commands.resolveIngressClass(ingress?.className ?? null),
    enabled: !!ingress,
  });

  // The soonest expiry across every certificate this Ingress serves: one
  // Ingress with four hosts has four certificates, and the badge can only
  // carry the one that runs out first.
  const soonest = tlsConfigs
    .map((config) =>
      config.secretName
        ? certificates.data?.get(config.secretName)?.certificate
        : undefined
    )
    .filter((cert) => cert != null)
    .map((cert) => expiryOf(cert))
    .sort((a, b) => a.days - b.days)[0];

  const {
    data: events = [],
    isLoading: eventsLoading,
    error: eventsError,
    refetch: refetchEvents,
  } = useQuery({
    queryKey: ["ingress-events", namespace, name],
    queryFn: async () => {
      const filters: EventFilters = {
        namespace: namespace || null,
        involved_object_name: name || null,
        involved_object_kind: ResourceType.Ingress,
        event_type: null,
        field_selector: null,
        limit: 100,
      };
      return await commands.listEvents(filters);
    },
    enabled: !!name && !!namespace,
    refetchInterval: REFRESH_INTERVALS.overview,
  });

  const facts: KeyValue[] = [
    {
      // The class is a request; the controller is who answers it. Naming
      // only the request is how an Ingress nothing serves reads as fine.
      label: "Class",
      value: controller
        ? controller.resolved
          ? `${controller.resolved}${controller.controller ? ` · ${controller.controller}` : ""}`
          : `${ingress?.className ?? "no class"} — nothing serves it`
        : ingress?.className || "cluster default",
      mono: !!ingress?.className,
      tone: controller && !controller.resolved ? ("err" as const) : undefined,
    },
    {
      label: "Load balancer",
      // Until the controller assigns an address nothing reaches this ingress,
      // which is the single most common reason it "does not work".
      // The empty state keeps its own tone, so it stays plain text rather
      // than the component's faint fallback.
      value:
        loadBalancerIps.length > 0 ? (
          <CopyableAddresses values={loadBalancerIps} label="Ingress address" />
        ) : (
          "pending"
        ),
      tone: loadBalancerIps.length > 0 ? undefined : ("warn" as const),
    },
    { label: "Rules", value: rules.length, mono: true },
    { label: "Paths", value: accessUrls.length, mono: true },
    {
      label: "TLS",
      // Once the certificate has been read, how long it has left is a more
      // useful answer than how many hosts it covers — the host count is a
      // shape, and the expiry is a date somebody has to act on.
      value: !hasTls
        ? "none — traffic is unencrypted"
        : soonest
          ? soonest.text
          : hasCatchAllTls
            ? "catch-all certificate"
            : `${tlsHosts.length} host${tlsHosts.length === 1 ? "" : "s"}`,
      tone: !hasTls
        ? "warn"
        : (soonest?.tone ?? (hasCatchAllTls ? "warn" : undefined)),
    },
  ];

  const deliveryQuery = deliveryOfKind(ResourceType.Ingress, ingress);

  const tabs = [
    {
      id: "overview",
      label: "Overview",
      glyph: viewGlyph(Info),
      content: (
        <>
          <KeyValueSection title="Ingress" items={facts} className="max-w-lg" />

          <TrafficChain
            query={connections}
            certificates={certificates.data}
            issuance={issuance}
            controller={controller}
          />
        </>
      ),
    },
    {
      id: "access",
      label: "Access",
      glyph: viewGlyph(ExternalLink),
      content: (
        <Section>
          <SectionHeader
            title="Reachable at"
            count={
              plainHttp > 0
                ? `${countOf(accessUrls.length, "path")} · ${plainHttp} over plain HTTP`
                : countOf(accessUrls.length, "path")
            }
          />
          {accessUrls.length === 0 ? (
            <p className="text-xs text-fg-fnt">
              No rules, so this ingress routes nothing.
            </p>
          ) : (
            <div>
              {accessUrls.map((url) => (
                <div key={`${url.host}${url.path}`} className={ACCESS_ROW}>
                  <span
                    className={cn(
                      "text-[11px] font-medium",
                      url.isHttps ? "text-fg-fnt" : "text-warn"
                    )}
                  >
                    {url.isHttps ? "HTTPS" : "HTTP"}
                  </span>
                  <span className="min-w-0 break-all font-mono text-fg">
                    <span className="text-fg-mut">{url.displayHost}</span>
                    {url.path}
                  </span>
                  <span className="min-w-0 truncate text-fg-fnt">
                    {url.resourceBackend ? (
                      <span className="font-mono">{url.resourceBackend}</span>
                    ) : url.backendService ? (
                      <>
                        <ResourceRef
                          kind={ResourceType.Service}
                          name={url.backendService}
                          namespace={ingress?.namespace}
                          showKind={false}
                        />
                        <span className="font-mono">:{url.backendPort}</span>
                      </>
                    ) : (
                      "no backend"
                    )}
                  </span>
                  <span className="flex justify-end gap-0.5">
                    <IconAction
                      label="Copy URL"
                      icon={Copy}
                      onClick={() =>
                        copyToClipboard(
                          url.host && url.host !== "*" ? url.fullUrl : url.path
                        )
                      }
                    />
                    {url.host && url.host !== "*" && (
                      <IconAction
                        label="Open in browser"
                        icon={ExternalLink}
                        onClick={() =>
                          window.open(url.fullUrl, "_blank", "noreferrer")
                        }
                      />
                    )}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Section>
      ),
    },
    connectionsTab(connections, deliveryQuery),
    {
      id: "rules",
      label: "Rules",
      glyph: viewGlyph(Route),
      mark: countMark(rules.length),
      content: (
        <Section>
          <SectionHeader title="Rules" count={countOf(rules.length, "host")} />
          {rules.length === 0 ? (
            <p className="text-xs text-fg-fnt">
              No rules, so this ingress routes nothing — every request reaching
              the controller falls through to its default backend.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Path</TableHead>
                  <TableHead>Match</TableHead>
                  <TableHead>Backend</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rules.map((rule, ruleIdx) => {
                  const isWildcard = rule.host === "*" || !rule.host;
                  const covered =
                    tlsHosts.includes(rule.host) || hasCatchAllTls;
                  return [
                    // The host is context for the paths under it, so it is
                    // said once above them instead of on every row.
                    <TableRow
                      key={`host-${ruleIdx}`}
                      data-quiet
                      className="border-0"
                    >
                      <TableCell
                        colSpan={3}
                        className="px-2.5 pb-1 pt-3 text-[11px] text-fg-fnt"
                      >
                        <span className="font-mono text-fg-mut">
                          {isWildcard ? "All hosts" : rule.host}
                        </span>
                        {!covered && (
                          <span className="text-warn"> · no TLS</span>
                        )}
                      </TableCell>
                    </TableRow>,
                    ...rule.paths.map((path) => (
                      <TableRow key={`${ruleIdx}-${path.path}`} data-quiet>
                        <TableCell className="font-mono text-fg">
                          {path.path}
                        </TableCell>
                        <TableCell className="text-fg-fnt">
                          {path.pathType}
                        </TableCell>
                        <TableCell>
                          {path.resourceBackend ? (
                            <span className="font-mono text-fg-mut">
                              {path.resourceBackend}
                            </span>
                          ) : path.backendService ? (
                            <>
                              <ResourceRef
                                kind={ResourceType.Service}
                                name={path.backendService}
                                namespace={ingress?.namespace}
                                showKind={false}
                              />
                              <span className="font-mono text-fg-fnt">
                                :{path.backendPort}
                              </span>
                            </>
                          ) : (
                            <span className="text-warn">no backend</span>
                          )}
                        </TableCell>
                      </TableRow>
                    )),
                  ];
                })}
              </TableBody>
            </Table>
          )}
        </Section>
      ),
    },
    {
      id: "tls",
      label: "TLS",
      glyph: viewGlyph(Lock),
      content: (
        <Section>
          <SectionHeader title="TLS" count={tlsConfigs.length || undefined} />
          {tlsConfigs.length === 0 ? (
            <p className="text-xs text-fg-fnt">
              No TLS configured — this ingress serves plain HTTP.
            </p>
          ) : (
            <KeyValueList
              items={tlsConfigs.map((config) => ({
                // The certificate lives in a Secret in this namespace, and
                // "which Secret holds the cert for this host" is the question
                // this tab exists to answer — so the label is the way to it.
                // `showKind` is off: the block is titled TLS and every row in
                // it is a Secret.
                label: config.secretName ? (
                  <ResourceRef
                    kind={ResourceType.Secret}
                    name={config.secretName}
                    namespace={ingress?.namespace}
                    showKind={false}
                  />
                ) : (
                  "(auto-generated)"
                ),
                value: (
                  <span className="flex flex-col gap-0.5">
                    <span className={cn(!config.isCatchAll && "font-mono")}>
                      {config.isCatchAll
                        ? "catch-all · applies to every host not listed"
                        : config.hosts.join(", ") || "no hosts"}
                    </span>
                    {config.secretName && (
                      <CertificateLine
                        read={certificates.data?.get(config.secretName)}
                        hosts={config.hosts}
                      />
                    )}
                  </span>
                ),
                tone: config.isCatchAll ? ("warn" as const) : undefined,
              }))}
            />
          )}
          {/* The four objects and the sentence that says what failed. Below
              the certificate facts, because those are core and read the
              same on a cluster with nothing installed on it. */}
          {tlsConfigs.map(
            (config) =>
              config.secretName && (
                <IssuanceSection
                  key={config.secretName}
                  issuance={issuance}
                  secretName={config.secretName}
                />
              )
          )}
        </Section>
      ),
    },
    {
      id: "metadata",
      label: "Metadata",
      glyph: viewGlyph(Tag),
      content: (
        <>
          <KeyValueSection
            title="Labels"
            count={Object.keys(ingress?.labels ?? {}).length}
            items={recordToKeyValues(ingress?.labels ?? {})}
            emptyMessage="No labels"
          />
          <KeyValueSection
            title="Annotations"
            count={Object.keys(ingress?.annotations ?? {}).length}
            items={recordToKeyValues(ingress?.annotations ?? {})}
            emptyMessage="No annotations"
          />
        </>
      ),
    },
    {
      id: "events",
      label: "Events",
      glyph: kindGlyph(ResourceType.Event),
      mark: countMark(events.length),
      content: (
        <Section>
          <SectionHeader
            title="Events"
            count={events.length || undefined}
            actions={
              eventsError && (
                <DetailAction label="Retry" onClick={() => refetchEvents()} />
              )
            }
          />
          {eventsError ? (
            <p className="text-xs text-warn">
              Could not read events for this ingress.
            </p>
          ) : eventsLoading ? (
            <div className="flex flex-col gap-1.5">
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-3/4" />
            </div>
          ) : (
            <EventRows events={events} />
          )}
        </Section>
      ),
    },
    yamlTab({
      title: "Ingress YAML",
      yaml: ingressYaml,
      resourceKind: ResourceType.Ingress,
      resourceName: name || "",
      namespace,
      onCopy: copyYaml,
    }),
  ];

  return (
    <ResourceDetailLayout
      resource={ingress}
      delivery={deliveryQuery}
      isLoading={isLoading}
      error={error}
      resourceKind={ResourceType.Ingress}
      title={ingress?.name || name || ""}
      namespace={ingress?.namespace || namespace}
      createdAt={ingress?.createdAt}
      badges={
        <>
          {ingress?.className && (
            <span className="font-mono text-[11px] text-fg-mut">
              {ingress.className}
            </span>
          )}
          <span
            className={cn(
              "text-[11px]",
              !hasTls
                ? "text-warn"
                : soonest?.tone
                  ? TONE_CLASS[soonest.tone]
                  : "text-fg-fnt"
            )}
          >
            {!hasTls ? "no TLS" : (soonest?.tone && soonest.text) || "TLS"}
          </span>
        </>
      }
      onBack={goBack}
      activeTab={activeTab}
      onTabChange={setActiveTab}
      tabs={tabs}
    />
  );
}
