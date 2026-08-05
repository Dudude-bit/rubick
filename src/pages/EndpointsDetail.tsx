import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Section, SectionHeader } from "@/components/ui/section";
import { YamlTabContent } from "@/components/resources/YamlTabContent";
import { ResourceDetailLayout } from "@/components/resources/ResourceDetailLayout";
import { ResourceLink } from "@/components/resources/detail-blocks";
import {
  KeyValueSection,
  type KeyValue,
} from "@/components/resources/detail-kv";
import { useResourceDetail } from "@/hooks";
import { ResourceType } from "@/lib/resource-registry";
import { commands } from "@/lib/commands";
import type { EndpointAddress, EndpointsInfo } from "@/generated/types";

/** Every address in the object, flattened, carrying its readiness. */
type Backend = {
  address: EndpointAddress;
  ready: boolean;
  /** Which subset it came from — only shown when there is more than one. */
  subset: number;
};

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
  const backends: Backend[] = subsets.flatMap((subset, index) => [
    ...subset.addresses.map((address) => ({
      address,
      ready: true,
      subset: index,
    })),
    ...subset.notReadyAddresses.map((address) => ({
      address,
      ready: false,
      subset: index,
    })),
  ]);
  const totalReady = backends.filter((b) => b.ready).length;
  const totalNotReady = backends.length - totalReady;
  const allPorts = subsets.flatMap((s) => s.ports);
  const showSubset = subsets.length > 1;

  const facts: KeyValue[] = [
    {
      label: "Service",
      value: (
        <ResourceLink
          kind={ResourceType.Service}
          name={endpoints?.name || name || ""}
          namespace={endpoints?.namespace || namespace}
        />
      ),
    },
    { label: "Ready", value: totalReady, mono: true },
    {
      label: "Not ready",
      value: totalNotReady,
      mono: true,
      // An endpoints object with backends that are not ready is the reason a
      // service is dropping traffic, so this row is the one that gets colour.
      tone: totalNotReady > 0 ? "warn" : undefined,
    },
    { label: "Ports", value: allPorts.length, mono: true },
  ];

  const tabs = [
    {
      id: "addresses",
      label: "Backends",
      content: (
        <Section>
          <SectionHeader
            title="Backends"
            count={
              totalNotReady > 0
                ? `${totalReady} ready · ${totalNotReady} not ready`
                : `${totalReady} ready`
            }
          />
          {backends.length === 0 ? (
            <p className="text-xs text-fg-fnt">
              No backends — nothing is behind this service right now.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Address</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead>Target</TableHead>
                  <TableHead>Node</TableHead>
                  {showSubset && <TableHead>Subset</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {backends.map(({ address, ready, subset }) => (
                  <TableRow key={`${subset}/${address.ip}`} data-quiet>
                    <TableCell className="font-mono text-fg">
                      {address.ip}
                    </TableCell>
                    <TableCell className={ready ? "text-fg-mut" : "text-warn"}>
                      {ready ? "Ready" : "Not ready"}
                    </TableCell>
                    <TableCell>
                      {address.targetRef ? (
                        address.targetRef.kind === ResourceType.Pod ? (
                          <ResourceLink
                            kind={ResourceType.Pod}
                            name={address.targetRef.name}
                            namespace={
                              address.targetRef.namespace ||
                              endpoints?.namespace
                            }
                          />
                        ) : (
                          <span className="font-mono text-fg-mut">
                            {address.targetRef.kind}/{address.targetRef.name}
                          </span>
                        )
                      ) : (
                        <span className="text-fg-fnt">—</span>
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-fg-mut">
                      {address.nodeName ?? "—"}
                    </TableCell>
                    {showSubset && (
                      <TableCell className="text-fg-fnt">
                        {subset + 1}
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Section>
      ),
    },
    {
      id: "ports",
      label: "Ports",
      content: (
        <Section>
          <SectionHeader title="Ports" count={allPorts.length} />
          {allPorts.length === 0 ? (
            <p className="text-xs text-fg-fnt">No ports defined</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Port</TableHead>
                  <TableHead>Protocol</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {allPorts.map((port) => (
                  <TableRow
                    key={`${port.name ?? ""}/${port.protocol}/${port.port}`}
                    data-quiet
                  >
                    <TableCell className="text-fg-mut">
                      {port.name || "—"}
                    </TableCell>
                    <TableCell className="font-mono text-fg">
                      {port.port}
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
      createdAt={endpoints?.createdAt}
      badges={
        <span
          className={
            totalNotReady > 0
              ? "text-[11px] text-warn"
              : "text-[11px] text-fg-mut"
          }
        >
          {totalReady} ready
          {totalNotReady > 0 && ` · ${totalNotReady} not ready`}
        </span>
      }
      onBack={goBack}
      activeTab={activeTab}
      onTabChange={setActiveTab}
      tabs={tabs}
    >
      <KeyValueSection title="Endpoints" items={facts} className="max-w-lg" />
    </ResourceDetailLayout>
  );
}
