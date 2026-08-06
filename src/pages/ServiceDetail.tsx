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
import { ResourceDetailLayout } from "@/components/resources/ResourceDetailLayout";
import {
  KeyValueSection,
  type KeyValue,
} from "@/components/resources/detail-kv";
import { recordToKeyValues } from "@/components/resources/key-values";
import { ServiceAccessInfo, MatchingPods } from "@/components/network";
import { useResourceDetail } from "@/hooks";
import { ResourceType } from "@/lib/resource-registry";
import { commands } from "@/lib/commands";
import type { ServiceInfo } from "@/generated/types";

export function ServiceDetail() {
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
  } = useResourceDetail<ServiceInfo>({
    resourceKind: ResourceType.Service,
    fetchResource: (name, ns) => commands.getService(name, ns),
    deleteResource: (name, ns) => commands.deleteService(name, ns),
    defaultTab: "access",
  });

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

  const tabs = [
    {
      id: "access",
      label: "Access",
      content: service ? <ServiceAccessInfo service={service} /> : null,
    },
    {
      id: "ports",
      label: "Ports",
      content: (
        <Section>
          <SectionHeader title="Ports" count={ports.length} />
          {ports.length === 0 ? (
            <p className="text-xs text-fg-fnt">No ports defined</p>
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
      content: (
        <KeyValueSection
          title="Pod selector"
          count={Object.keys(service?.selector ?? {}).length}
          items={recordToKeyValues(service?.selector ?? {})}
          emptyMessage="No selector — this service does not pick pods by label"
        />
      ),
    },
    {
      id: "pods",
      label: "Pods",
      content: service ? (
        <MatchingPods
          namespace={service.namespace}
          selector={service.selector}
        />
      ) : null,
    },
    {
      id: "labels",
      label: "Metadata",
      content: (
        <>
          <KeyValueSection
            title="Labels"
            count={Object.keys(service?.labels ?? {}).length}
            items={recordToKeyValues(service?.labels ?? {})}
            emptyMessage="No labels"
          />
          <KeyValueSection
            title="Annotations"
            count={Object.keys(service?.annotations ?? {}).length}
            items={recordToKeyValues(service?.annotations ?? {})}
            emptyMessage="No annotations"
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
      resource={service}
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
    >
      <KeyValueSection title="Service" items={facts} className="max-w-lg" />
    </ResourceDetailLayout>
  );
}
