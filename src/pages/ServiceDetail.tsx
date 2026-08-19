import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Section, SectionHeader } from "@/components/ui/section";
import {
  CopyableAddress,
  CopyableAddresses,
} from "@/components/ui/copyable-value";
import { yamlTab } from "@/components/resources/yaml-tab";
import { ExternalLink, Filter, Info, Plug, Tag, Waypoints } from "lucide-react";
import { ResourceDetailLayout } from "@/components/resources/ResourceDetailLayout";
import { countMark, viewGlyph } from "@/components/resources/detail-tab";
import {
  KeyValueSection,
  type KeyValue,
} from "@/components/resources/detail-kv";
import { recordToKeyValues } from "@/components/resources/key-values";
import { ServiceAccessInfo } from "@/components/network";
import { TrafficChain } from "@/components/resources/TrafficChain";
import { PublishedEndpoints } from "@/components/resources/PublishedEndpoints";
import { connectionsTab } from "@/components/resources/connections-tab";
import { useResourceDetail } from "@/hooks";
import { useConnections } from "@/hooks/useConnections";
import { ResourceType } from "@/lib/resource-registry";
import { deliveryOfKind } from "@/lib/delivery";
import { publishedFor } from "@/lib/published";
import { commands } from "@/lib/commands";
import type { ServiceInfo } from "@/generated/types";
import { useT } from "@/i18n/useT";

export function ServiceDetail() {
  const t = useT();
  const {
    name,
    namespace,
    resource: service,
    isLoading,
    error,
    yaml: serviceYaml,
    copyYaml,
    activeTab,
    setActiveTab,
    goBack,
    freshness,
  } = useResourceDetail<ServiceInfo>({
    resourceKind: ResourceType.Service,
    fetchResource: (name, ns) => commands.getService(name, ns),
    deleteResource: (name, ns) => commands.deleteService(name, ns),
    defaultTab: "overview",
  });

  const connections = useConnections(ResourceType.Service, name, namespace);
  const subject = connections.data?.subject ?? null;
  const published = connections.data
    ? publishedFor(connections.data, connections.data.subject)
    : undefined;

  if (!service && !isLoading && !error) {
    return null;
  }

  const ports = service?.ports ?? [];
  const externalIps = service?.externalIps ?? [];
  const loadBalancerIps = service?.loadBalancerIps ?? [];

  const facts: KeyValue[] = [
    { label: "Type", value: service?.type },
    // A headless service has no cluster IP at all; "None" is the API's own
    // word for it and means something different from "not assigned yet".
    {
      label: "Cluster IP",
      value: (
        <CopyableAddress
          value={service?.clusterIp}
          label="Cluster IP"
          fallback="None"
        />
      ),
    },
    {
      label: "External IPs",
      value: <CopyableAddresses values={externalIps} label="External IP" />,
    },
    ...(service?.type === "LoadBalancer"
      ? [
          {
            label: "Load balancer",
            // The empty state keeps its own tone, so it stays plain text
            // rather than the component's faint fallback.
            value:
              loadBalancerIps.length > 0 ? (
                <CopyableAddresses
                  values={loadBalancerIps}
                  label="Load balancer address"
                />
              ) : (
                "pending"
              ),
            tone: loadBalancerIps.length > 0 ? undefined : ("warn" as const),
          },
        ]
      : []),
    { label: "Session affinity", value: service?.sessionAffinity || "None" },
  ];

  const deliveryQuery = deliveryOfKind(ResourceType.Service, service);

  const tabs = [
    {
      id: "overview",
      label: "Overview",
      glyph: viewGlyph(Info),
      content: (
        <>
          <KeyValueSection title="Service" items={facts} className="max-w-lg" />

          <TrafficChain query={connections} />
        </>
      ),
    },
    {
      id: "access",
      label: "Access",
      glyph: viewGlyph(ExternalLink),
      content: service ? <ServiceAccessInfo service={service} /> : null,
    },
    connectionsTab(connections, deliveryQuery),
    {
      id: "ports",
      label: "Ports",
      glyph: viewGlyph(Plug),
      mark: countMark(ports.length),
      content: (
        <Section>
          <SectionHeader title="Ports" count={ports.length} />
          {ports.length === 0 ? (
            <p className="text-xs text-fg-fnt">
              No ports declared, so this Service accepts no traffic — nothing
              reaches the pods its selector matches.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Port</TableHead>
                  <TableHead>Target</TableHead>
                  <TableHead>Node port</TableHead>
                  <TableHead>Protocol</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {ports.map((port) => (
                  <TableRow key={`${port.protocol}/${port.port}`} data-quiet>
                    <TableCell className="text-fg-mut">
                      {port.name || "—"}
                    </TableCell>
                    <TableCell className="font-mono text-fg">
                      {port.port}
                    </TableCell>
                    <TableCell className="font-mono text-fg-mut">
                      {port.targetPort}
                    </TableCell>
                    <TableCell className="font-mono text-fg-mut">
                      {port.nodePort ?? "—"}
                    </TableCell>
                    <TableCell className="text-fg-fnt">
                      {port.protocol}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Section>
      ),
    },
    {
      id: "selector",
      label: "Selector",
      glyph: viewGlyph(Filter),
      content: (
        <KeyValueSection
          title="Pod selector"
          count={Object.keys(service?.selector ?? {}).length}
          items={recordToKeyValues(service?.selector ?? {})}
          emptyMessage={t("empty", "noSelectorService")}
        />
      ),
    },
    // Not a Pods tab. The pods the selector matches is what the Selector tab
    // states as a rule, and it is not the question — what the cluster hands
    // to kube-proxy is, and the two come apart.
    {
      id: "endpoints",
      label: "Endpoints",
      glyph: viewGlyph(Waypoints),
      mark: countMark(published ? published.ready + published.draining : 0),
      content: subject ? (
        <PublishedEndpoints query={connections} service={subject} />
      ) : null,
    },
    {
      id: "labels",
      label: "Metadata",
      glyph: viewGlyph(Tag),
      content: (
        <>
          <KeyValueSection
            title="Labels"
            count={Object.keys(service?.labels ?? {}).length}
            items={recordToKeyValues(service?.labels ?? {})}
            emptyMessage={t("empty", "noLabels")}
          />
          <KeyValueSection
            title="Annotations"
            count={Object.keys(service?.annotations ?? {}).length}
            items={recordToKeyValues(service?.annotations ?? {})}
            emptyMessage={t("empty", "noAnnotations")}
          />
        </>
      ),
    },
    yamlTab({
      title: "Service YAML",
      yaml: serviceYaml,
      resourceKind: ResourceType.Service,
      resourceName: name || "",
      namespace,
      onCopy: copyYaml,
    }),
  ];

  return (
    <ResourceDetailLayout
      freshness={freshness}
      resource={service}
      delivery={deliveryQuery}
      isLoading={isLoading}
      error={error}
      resourceKind={ResourceType.Service}
      title={service?.name || ""}
      namespace={service?.namespace}
      createdAt={service?.createdAt}
      badges={
        service && (
          <span className="text-[11px] text-fg-mut">{service.type}</span>
        )
      }
      onBack={goBack}
      tabs={tabs}
      activeTab={activeTab}
      onTabChange={setActiveTab}
    />
  );
}
