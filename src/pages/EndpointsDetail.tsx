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
import { useT } from "@/i18n/useT";

/** Every address in the object, flattened, carrying its readiness. */
type Backend = {
  address: EndpointAddress;
  ready: boolean;
  /** Which subset it came from — only shown when there is more than one. */
  subset: number;
};

export function EndpointsDetail() {
  const t = useT();
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
    freshness,
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
    { label: t("columns", "ready"), value: totalReady, mono: true },
    {
      label: t("columns", "notReadyCount"),
      value: totalNotReady,
      mono: true,
      // An endpoints object with backends that are not ready is the reason a
      // service is dropping traffic, so this row is the one that gets colour.
      tone: totalNotReady > 0 ? "warn" : undefined,
    },
    { label: t("columns", "ports"), value: allPorts.length, mono: true },
    ...(published
      ? [
          {
            label: t("nav", "published"),
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
      label: t("nav", "overview"),
      glyph: viewGlyph(Info),
      content: (
        <KeyValueSection title="Endpoints" items={facts} className="max-w-lg" />
      ),
    },
    {
      id: "addresses",
      label: t("nav", "backends"),
      glyph: viewGlyph(Waypoints),
      mark: countMark(backends.length),
      content: (
        <Section>
          <SectionHeader
            title={t("nav", "backends")}
            count={
              totalNotReady > 0
                ? t("count", "readyNotReadySummary", {
                    n: totalReady,
                    notReady: totalNotReady,
                  })
                : t("count", "readySummary", { n: totalReady })
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
            <p className="text-xs text-fg-fnt">{t("empty", "noBackends")}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("columns", "address")}</TableHead>
                  <TableHead>{t("columns", "state")}</TableHead>
                  <TableHead>{t("columns", "target")}</TableHead>
                  <TableHead>{t("columns", "node")}</TableHead>
                  {showSubset && (
                    <TableHead>{t("columns", "subset")}</TableHead>
                  )}
                </TableRow>
              </TableHeader>
              <TableBody>
                {backends.map(({ address, ready, subset }) => (
                  <TableRow key={`${subset}/${address.ip}`} data-quiet>
                    <TableCell>
                      <CopyableAddress
                        value={address.ip}
                        label={t("columns", "address")}
                      />
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={ready ? "Ready" : "NotReady"}>
                        {ready
                          ? t("empty", "readyOne")
                          : t("empty", "notReadyOne")}
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
      label: t("columns", "ports"),
      glyph: viewGlyph(Plug),
      mark: countMark(allPorts.length),
      content: (
        <Section>
          <SectionHeader
            title={t("columns", "ports")}
            count={allPorts.length || undefined}
          />
          {allPorts.length === 0 ? (
            <p className="text-xs text-fg-fnt">
              {t("empty", "noPortsInSubsets")}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("columns", "name")}</TableHead>
                  <TableHead>{t("columns", "port")}</TableHead>
                  <TableHead>{t("columns", "protocol")}</TableHead>
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
      freshness={freshness}
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
          {t("count", "readySummary", { n: totalReady })}
          {totalNotReady > 0 &&
            ` · ${t("count", "notReadySummary", { n: totalNotReady })}`}
        </span>
      }
      onBack={goBack}
      activeTab={activeTab}
      onTabChange={setActiveTab}
      tabs={tabs}
    />
  );
}
