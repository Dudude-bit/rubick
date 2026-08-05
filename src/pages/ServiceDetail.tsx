import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { YamlTabContent } from "@/components/resources/YamlTabContent";
import { LabelsDisplay } from "@/components/resources/LabelsDisplay";
import { AnnotationsDisplay } from "@/components/resources/AnnotationsDisplay";
import {
  InfoCard,
  ResourceDetailLayout,
} from "@/components/resources/ResourceDetailLayout";
import {
  ServiceAccessInfo,
  MatchingPods,
  ServiceTypeBadge,
} from "@/components/network";
import { useResourceDetail } from "@/hooks";
import { ResourceType } from "@/lib/resource-registry";
import { Network } from "lucide-react";
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
  const selector = service?.selector ?? {};
  const labels = service?.labels ?? {};
  const annotations = service?.annotations ?? {};

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
        <Card>
          <CardHeader>
            <CardTitle>Service Ports</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {ports.map((port, idx) => (
                <div
                  key={idx}
                  className="flex items-center justify-between rounded-lg border p-3"
                >
                  <div className="flex items-center gap-3">
                    <Badge variant="outline">{port.protocol}</Badge>
                    <span className="font-mono">
                      {port.name ? `${port.name}: ` : ""}
                      {port.port} → {port.targetPort}
                    </span>
                  </div>
                  {port.nodePort && (
                    <Badge variant="secondary">NodePort: {port.nodePort}</Badge>
                  )}
                </div>
              ))}
              {ports.length === 0 && (
                <p className="text-muted-foreground">No ports defined</p>
              )}
            </div>
          </CardContent>
        </Card>
      ),
    },
    {
      id: "selector",
      label: "Selector",
      content: (
        <LabelsDisplay
          labels={selector}
          title="Pod Selector"
          emptyMessage="No selector defined"
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
      label: "Labels",
      content: (
        <div className="space-y-4">
          <LabelsDisplay labels={labels} title="Labels" />
          <AnnotationsDisplay annotations={annotations} />
        </div>
      ),
    },
    {
      id: "yaml",
      label: "YAML",
      content: (
        <YamlTabContent
          title="Service YAML"
          yaml={serviceYaml}
          resourceKind={ResourceType.Service}
          resourceName={name || ""}
          namespace={namespace}
          onCopy={copyYaml}
        />
      ),
    },
  ];

  return (
    <ResourceDetailLayout
      resource={service}
      isLoading={isLoading}
      error={error}
      resourceKind={ResourceType.Service}
      title={service?.name || ""}
      namespace={service?.namespace}
      statusBadge={service?.type && <ServiceTypeBadge type={service.type} />}
      icon={<Network className="h-8 w-8 text-muted-foreground" />}
      onBack={goBack}
      tabs={tabs}
      activeTab={activeTab}
      onTabChange={setActiveTab}
    >
      <div className="grid gap-4 md:grid-cols-3">
        <InfoCard title="Cluster IP">
          <div className="text-xl font-bold font-mono">
            {service?.clusterIp || "None"}
          </div>
        </InfoCard>

        <InfoCard title="External IPs">
          <div className="text-xl font-bold font-mono">
            {externalIps.length > 0 ? externalIps.join(", ") : "None"}
          </div>
        </InfoCard>

        <InfoCard title="Ports">
          <div className="text-xl font-bold">{ports.length}</div>
        </InfoCard>
      </div>
    </ResourceDetailLayout>
  );
}
