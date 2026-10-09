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
import { yamlTab } from "../../../-object/yaml-tab";
import { useState } from "react";
import {
  ExternalLink,
  Filter,
  Info,
  Network,
  Plug,
  Tag,
  Waypoints,
} from "lucide-react";
import { ReasonedAction } from "@/components/object/detail-blocks";
import { usePodDenied } from "@/lib/access";
import { PortForwardDialog } from "@/components/port-forward/PortForwardDialog";
import { ResourceDetailLayout } from "../../../-object/ResourceDetailLayout";
import { DeleteAction } from "../../../-object/DeleteAction";
import { useDeliveryIntercept } from "../../../-delivery/useDelivery";
import { countMark, viewGlyph } from "@/components/object/detail-tab";
import { KeyValueSection, type KeyValue } from "../../../-object/detail-kv";
import { recordToKeyValues } from "@/components/object/key-values";
import { ServiceAccessInfo } from "../../-components";
import { TrafficChain } from "../../../-object/TrafficChain";
import { BalancerAddress } from "../../../-object/BalancerAddress";
import { ClusterIpValue } from "../../../-object/ClusterIpValue";
import { ServiceVerdict } from "../../../-object/health-views";
import { endpointsMark } from "./endpoints-mark";
import { PublishedEndpoints } from "./PublishedEndpoints";
import { connectionsTab } from "../../../-object/connections-tab";
import { useResourceDetail } from "@/hooks";
import { useConnections } from "@/hooks/useConnections";
import { useServiceAnswer } from "@/hooks/useServiceAnswer";
import { useServiceShare } from "./useServiceShare";
import { ResourceType } from "@/lib/resource-registry";
import { deliveryOfKind } from "@/lib/delivery";
import { commands } from "@/lib/commands";
import type { ServiceInfo } from "@/generated/types";
import { useT } from "@/i18n/useT";
import { None } from "@/components/ui/none";
import { eventsTab } from "../../../-object/events-tab";
import { useObjectEvents } from "@/hooks/useObjectEvents";

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
    deleteMutation,
  } = useResourceDetail<ServiceInfo>({
    resourceKind: ResourceType.Service,
    fetchResource: (name, ns) => commands.getService(name, ns),
    deleteResource: (name, ns) => commands.deleteService(name, ns),
    defaultTab: "overview",
  });

  const events = useObjectEvents(ResourceType.Service, name, namespace, {
    refresh: "slow",
  });

  const connections = useConnections(ResourceType.Service, name, namespace);
  const { read } = useServiceAnswer(name, namespace, connections, true);
  const share = useServiceShare(service, read);
  const deliveryQuery = deliveryOfKind(ResourceType.Service, service);
  const intercept = useDeliveryIntercept(deliveryQuery);
  const [forwardOpen, setForwardOpen] = useState(false);
  const forwardDenied = usePodDenied(namespace || null).portForward;

  if (!service && !isLoading && !error) {
    return null;
  }

  const ports = service?.ports ?? [];
  const externalIps = service?.externalIps ?? [];

  const facts: KeyValue[] = [
    {
      label: t("columns", "status"),
      value: name ? <ServiceVerdict read={read} /> : null,
    },
    { label: t("columns", "type"), value: service?.type },
    ...(service?.type === "ExternalName"
      ? [
          {
            label: t("columns", "externalName"),
            value: (
              <CopyableAddress
                value={service.externalName}
                label={t("columns", "externalName")}
              />
            ),
          },
        ]
      : []),
    {
      label: t("columns", "clusterIp"),
      value: service ? <ClusterIpValue clusterIp={service.clusterIp} /> : null,
    },
    {
      label: t("columns", "externalIps"),
      value: (
        <CopyableAddresses
          values={externalIps}
          label={t("columns", "externalIp")}
        />
      ),
    },
    ...(service?.type === "LoadBalancer"
      ? [
          {
            label: t("columns", "loadBalancer"),
            value: <BalancerAddress service={service} />,
          },
        ]
      : []),
    {
      label: t("columns", "sessionAffinity"),
      value:
        service?.sessionAffinity && service.sessionAffinity !== "None" ? (
          service.sessionAffinity
        ) : (
          <None />
        ),
    },
  ];

  const tabs = [
    {
      id: "overview",
      label: t("nav", "overview"),
      glyph: viewGlyph(Info),
      content: (
        <>
          <KeyValueSection title="Service" items={facts} className="max-w-lg" />

          <TrafficChain query={read} />
        </>
      ),
    },
    {
      id: "access",
      label: t("nav", "access"),
      glyph: viewGlyph(ExternalLink),
      content: service ? (
        <ServiceAccessInfo
          service={service}
          onForward={() => setForwardOpen(true)}
        />
      ) : null,
    },
    connectionsTab(read, t, deliveryQuery),
    {
      id: "ports",
      label: t("columns", "ports"),
      glyph: viewGlyph(Plug),
      mark: countMark(ports.length),
      content: (
        <Section>
          <SectionHeader
            title={t("columns", "ports")}
            count={ports.length || undefined}
          />
          {ports.length === 0 ? (
            <p className="text-xs text-fg-fnt">
              {t("empty", "noPortsDeclared")}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("columns", "name")}</TableHead>
                  <TableHead>{t("columns", "port")}</TableHead>
                  <TableHead>{t("columns", "target")}</TableHead>
                  <TableHead>{t("columns", "nodePort")}</TableHead>
                  <TableHead>{t("columns", "protocol")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {ports.map((port) => (
                  <TableRow key={`${port.protocol}/${port.port}`} data-quiet>
                    <TableCell className="text-fg-mut">
                      {port.name || <None />}
                    </TableCell>
                    <TableCell className="font-mono text-fg">
                      {port.port}
                    </TableCell>
                    <TableCell className="font-mono text-fg-mut">
                      {port.targetPort}
                    </TableCell>
                    <TableCell className="font-mono text-fg-mut">
                      {port.nodePort ?? <None />}
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
      label: t("nav", "selector"),
      glyph: viewGlyph(Filter),
      content: (
        <KeyValueSection
          title={t("nav", "podSelector")}
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
      mark: endpointsMark(read, t),
      content: <PublishedEndpoints query={read} />,
    },
    {
      id: "labels",
      label: t("nav", "metadata"),
      glyph: viewGlyph(Tag),
      content: (
        <>
          <KeyValueSection
            title={t("columns", "labels")}
            count={Object.keys(service?.labels ?? {}).length}
            items={recordToKeyValues(service?.labels ?? {})}
            emptyMessage={t("empty", "noLabels")}
          />
          <KeyValueSection
            title={t("columns", "annotations")}
            count={Object.keys(service?.annotations ?? {}).length}
            items={recordToKeyValues(service?.annotations ?? {})}
            emptyMessage={t("empty", "noAnnotations")}
          />
        </>
      ),
    },
    eventsTab(events, t, { kind: ResourceType.Service, name: name ?? "" }),
    yamlTab({
      title: t("action", "kindYaml", { kind: "Service" }),
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
      share={share}
      isLoading={isLoading}
      error={error}
      resourceKind={ResourceType.Service}
      title={service?.name || ""}
      namespace={service?.namespace}
      createdAt={service?.createdAt}
      statusBadge={service && <ServiceVerdict read={read} compact />}
      badges={
        service && (
          <span className="text-[11px] text-fg-mut">{service.type}</span>
        )
      }
      onBack={goBack}
      actions={
        <>
          {service && service.type !== "ExternalName" && (
            <ReasonedAction
              label={t("action", "portForward")}
              icon={Network}
              onClick={() => setForwardOpen(true)}
              reason={
                service.ports.length === 0
                  ? t("action", "serviceDeclaresNoPorts")
                  : forwardDenied
              }
            />
          )}
          <DeleteAction
            kind={ResourceType.Service}
            name={service?.name || name || ""}
            namespace={service?.namespace || namespace}
            detail={service}
            intercept={intercept("Delete")}
            mutation={deleteMutation}
          />
          {service && (
            <PortForwardDialog
              open={forwardOpen}
              onOpenChange={setForwardOpen}
              target={{
                kind: "Service",
                name: service.name,
                namespace: service.namespace,
                ports: service.ports.map((port) => ({
                  port: port.port,
                  name: port.name,
                  protocol: port.protocol,
                })),
              }}
            />
          )}
        </>
      }
      tabs={tabs}
      activeTab={activeTab}
      onTabChange={setActiveTab}
    />
  );
}
