import { Badge } from "@/components/ui/badge";
import { Section, SectionHeader } from "@/components/ui/section";
import { YamlTabContent } from "@/components/resources/YamlTabContent";
import {
  ResourceDetailLayout,
  InfoCard,
} from "@/components/resources/ResourceDetailLayout";
import { useResourceDetail } from "@/hooks";
import { ResourceType } from "@/lib/resource-registry";
import { Network, CircleDot } from "lucide-react";
import { LinkedResource } from "@/components/network";
import { commands } from "@/lib/commands";
import type { EndpointsInfo } from "@/generated/types";

export function EndpointsDetail() {
  const {
    name,
    namespace,
    resource: endpoints,
    isLoading,
    error,
    yaml: endpointsYaml,
    copyYaml,
    activeTab,
    setActiveTab,
    goBack,
  } = useResourceDetail<EndpointsInfo>({
    resourceKind: ResourceType.Endpoints,
    fetchResource: (name, ns) => commands.getEndpoints(name, ns),
    deleteResource: (name, ns) => commands.deleteEndpoints(name, ns),
    defaultTab: "addresses",
  });

  const subsets = endpoints?.subsets ?? [];
  const totalReady = subsets.reduce((acc, s) => acc + s.addresses.length, 0);
  const totalNotReady = subsets.reduce(
    (acc, s) => acc + s.notReadyAddresses.length,
    0
  );
  const allPorts = subsets.flatMap((s) => s.ports);

  const tabs = [
    {
      id: "addresses",
      label: "Addresses",
      content: (
        <div className="space-y-4">
          {subsets.map((subset, idx) => (
            <Section key={idx}>
              <SectionHeader
                title={`Subset ${idx + 1}`}
                count={`${subset.addresses.length} ready`}
                actions={
                  subset.notReadyAddresses.length > 0 && (
                    <Badge className="bg-warn/[0.16] text-warn border-warn/[0.16]">
                      {subset.notReadyAddresses.length} not ready
                    </Badge>
                  )
                }
              />
              <div className="space-y-4">
                {subset.addresses.length > 0 && (
                  <div>
                    <h4 className="text-sm font-medium mb-2 text-green-500">
                      Ready Addresses
                    </h4>
                    <div className="space-y-2">
                      {subset.addresses.map((addr, i) => (
                        <div
                          key={i}
                          className="flex items-center justify-between rounded-lg border p-2 bg-green-500/5"
                        >
                          <div className="flex items-center gap-2">
                            <CircleDot className="h-4 w-4 text-green-500" />
                            <span className="font-mono">{addr.ip}</span>
                          </div>
                          <div className="text-sm text-muted-foreground flex items-center gap-1">
                            {addr.targetRef &&
                            addr.targetRef.kind === ResourceType.Pod ? (
                              <LinkedResource
                                resourceType={ResourceType.Pod}
                                name={addr.targetRef.name}
                                namespace={
                                  addr.targetRef.namespace ||
                                  endpoints?.namespace ||
                                  ""
                                }
                              />
                            ) : addr.targetRef ? (
                              `${addr.targetRef.kind}/${addr.targetRef.name}`
                            ) : null}
                            {addr.nodeName && <span>@ {addr.nodeName}</span>}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {subset.notReadyAddresses.length > 0 && (
                  <div>
                    <h4 className="text-sm font-medium mb-2 text-yellow-500">
                      Not Ready Addresses
                    </h4>
                    <div className="space-y-2">
                      {subset.notReadyAddresses.map((addr, i) => (
                        <div
                          key={i}
                          className="flex items-center justify-between rounded-lg border p-2 bg-yellow-500/5"
                        >
                          <div className="flex items-center gap-2">
                            <CircleDot className="h-4 w-4 text-yellow-500" />
                            <span className="font-mono">{addr.ip}</span>
                          </div>
                          <div className="text-sm text-muted-foreground flex items-center gap-1">
                            {addr.targetRef &&
                            addr.targetRef.kind === ResourceType.Pod ? (
                              <LinkedResource
                                resourceType={ResourceType.Pod}
                                name={addr.targetRef.name}
                                namespace={
                                  addr.targetRef.namespace ||
                                  endpoints?.namespace ||
                                  ""
                                }
                              />
                            ) : addr.targetRef ? (
                              `${addr.targetRef.kind}/${addr.targetRef.name}`
                            ) : null}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </Section>
          ))}
          {subsets.length === 0 && (
            <Section>
              <div className="py-8 text-center text-muted-foreground">
                No endpoint subsets
              </div>
            </Section>
          )}
        </div>
      ),
    },
    {
      id: "ports",
      label: "Ports",
      content: (
        <Section>
          <SectionHeader title="Ports" />
          <div>
            {allPorts.length > 0 ? (
              <div className="space-y-2">
                {allPorts.map((port, i) => (
                  <div
                    key={i}
                    className="flex items-center justify-between rounded-lg border p-3"
                  >
                    <div className="flex items-center gap-3">
                      {port.name && (
                        <Badge variant="outline">{port.name}</Badge>
                      )}
                      <span className="font-mono">{port.port}</span>
                    </div>
                    <Badge variant="secondary">{port.protocol}</Badge>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-muted-foreground">No ports defined</p>
            )}
          </div>
        </Section>
      ),
    },
    {
      id: "yaml",
      label: "YAML",
      content: (
        <YamlTabContent
          title="Endpoints YAML"
          yaml={endpointsYaml}
          resourceKind={ResourceType.Endpoints}
          resourceName={name || ""}
          namespace={namespace}
          onCopy={copyYaml}
        />
      ),
    },
  ];

  return (
    <ResourceDetailLayout
      resource={endpoints}
      isLoading={isLoading}
      error={error}
      resourceKind={ResourceType.Endpoints}
      title={endpoints?.name || name || ""}
      namespace={endpoints?.namespace || namespace}
      badges={
        <>
          <LinkedResource
            resourceType={ResourceType.Service}
            name={endpoints?.name || name || ""}
            namespace={endpoints?.namespace || namespace || ""}
          />
          {totalReady > 0 && (
            <Badge className="bg-green-500/10 text-green-500 border-green-500/20">
              {totalReady} ready
            </Badge>
          )}
          {totalNotReady > 0 && (
            <Badge className="bg-yellow-500/10 text-yellow-500 border-yellow-500/20">
              {totalNotReady} not ready
            </Badge>
          )}
        </>
      }
      icon={<Network className="h-8 w-8 text-muted-foreground" />}
      onBack={goBack}
      activeTab={activeTab}
      onTabChange={setActiveTab}
      tabs={tabs}
    >
      <div className="grid gap-4 md:grid-cols-3">
        <InfoCard title="Ready Addresses">
          <div className="text-xl font-bold text-green-500">{totalReady}</div>
        </InfoCard>

        <InfoCard title="Not Ready">
          <div className="text-xl font-bold text-yellow-500">
            {totalNotReady}
          </div>
        </InfoCard>

        <InfoCard title="Ports">
          <div className="text-xl font-bold">{allPorts.length}</div>
        </InfoCard>
      </div>
    </ResourceDetailLayout>
  );
}
