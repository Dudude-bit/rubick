import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Section, SectionHeader } from "@/components/ui/section";
import { StatusBadge } from "@/components/ui/status-badge";
import { CopyableAddress } from "@/components/ui/copyable-value";
import { yamlTab } from "@/components/resources/yaml-tab";
import { Info, Plug, Waypoints } from "lucide-react";
import { ResourceDetailLayout } from "@/components/resources/ResourceDetailLayout";
import { countMark, viewGlyph } from "@/components/resources/detail-tab";
import { ResourceRef } from "@/components/resources/ResourceRef";
import {
  KeyValueSection,
  type KeyValue,
} from "@/components/resources/detail-kv";
import { useResourceDetail } from "@/hooks";
import { useQuery } from "@tanstack/react-query";
import { ResourceType } from "@/lib/resource-registry";
import { commands } from "@/lib/commands";
import { legacyNote, publishedSummary } from "@/lib/published";
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

  // What the Service really publishes. This object is the compatibility copy
  // — it truncates at 1000 and cannot say `serving` — so the page reads the
  // slices for the count and says where the number came from.
  const slices = useQuery({
    queryKey: ["service-endpoints", endpoints?.namespace ?? namespace],
    queryFn: () =>
      commands.listServiceEndpoints(endpoints?.namespace ?? namespace ?? null),
    enabled: Boolean(endpoints),
  });
  const published = slices.data?.find(
    (entry) => entry.service.name === (endpoints?.name ?? name)
  );

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
        <ResourceRef
          kind={ResourceType.Service}
          name={endpoints?.name || name || ""}
          namespace={endpoints?.namespace || namespace}
          showKind={false}
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
    ...(published
      ? [
          {
            label: "Published",
            value: publishedSummary(published),
            tone:
              published.draining > 0 || published.unrouted > 0
                ? ("warn" as const)
                : undefined,
          },
        ]
      : []),
  ];

  const tabs = [
    {
      id: "overview",
      label: "Overview",
      glyph: viewGlyph(Info),
      content: (
        <KeyValueSection title="Endpoints" items={facts} className="max-w-lg" />
      ),
    },
    {
      id: "addresses",
      label: "Backends",
      glyph: viewGlyph(Waypoints),
      mark: countMark(backends.length),
      content: (
        <Section>
          <SectionHeader
            title="Backends"
            count={
              totalNotReady > 0
                ? `${totalReady} ready · ${totalNotReady} not ready`
                : `${totalReady} ready`
            }
            description={
              slices.isPending
                ? undefined
                : legacyNote(
                    backends.length,
                    endpoints?.overCapacity ?? false,
                    published
                  )
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
                    <TableCell>
                      <CopyableAddress value={address.ip} label="Address" />
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={ready ? "Ready" : "NotReady"}>
                        {ready ? "Ready" : "Not ready"}
                      </StatusBadge>
                    </TableCell>
                    <TableCell>
                      {address.targetRef ? (
                        <ResourceRef
                          kind={address.targetRef.kind}
                          name={address.targetRef.name}
                          namespace={
                            address.targetRef.namespace || endpoints?.namespace
                          }
                          showKind={address.targetRef.kind !== ResourceType.Pod}
                        />
                      ) : (
                        <span className="text-fg-fnt">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {/* The column heading says Node, and the target cell
                          beside it has been a reference all along. */}
                      {address.nodeName ? (
                        <ResourceRef
                          kind={ResourceType.Node}
                          name={address.nodeName}
                          showKind={false}
                        />
                      ) : (
                        <span className="text-fg-fnt">—</span>
                      )}
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
      glyph: viewGlyph(Plug),
      mark: countMark(allPorts.length),
      content: (
        <Section>
          <SectionHeader title="Ports" count={allPorts.length} />
          {allPorts.length === 0 ? (
            <p className="text-xs text-fg-fnt">
              No ports across any subset — the backends above, if there are any,
              are reachable on nothing.
            </p>
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
    yamlTab({
      title: "Endpoints YAML",
      yaml: endpointsYaml,
      resourceKind: ResourceType.Endpoints,
      resourceName: name || "",
      namespace,
      onCopy: copyYaml,
    }),
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
    />
  );
}
