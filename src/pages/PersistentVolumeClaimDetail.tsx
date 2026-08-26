import { useLiveQuery } from "@/hooks/useLiveQuery";
import { Info, Trash2 } from "lucide-react";

import { Section, SectionHeader } from "@/components/ui/section";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
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
  KeyValueSection,
  type KeyValue,
} from "@/components/resources/detail-kv";
import { connectionsTab } from "@/components/resources/connections-tab";
import { useResourceDetail } from "@/hooks";
import { useConnections } from "@/hooks/useConnections";
import { commands } from "@/lib/commands";
import { deliveryOfKind } from "@/lib/delivery";
import { InterceptedAction } from "@/components/resources/delivery-intercept";
import { useDeliveryIntercept } from "@/hooks/useDelivery";
import { ResourceType } from "@/lib/resource-registry";
import type {
  EventFilters,
  PersistentVolumeClaimInfo,
} from "@/generated/types";
import { useT } from "@/i18n/useT";

export function PersistentVolumeClaimDetail() {
  const t = useT();
  const {
    name,
    namespace,
    resource: pvc,
    isLoading,
    error,
    yaml: pvcYaml,
    copyYaml,
    activeTab,
    setActiveTab,
    goBack,
    deleteMutation,
    freshness,
  } = useResourceDetail<PersistentVolumeClaimInfo>({
    resourceKind: ResourceType.PersistentVolumeClaim,
    fetchResource: (name, ns) => commands.getPersistentVolumeClaim(name, ns),
    deleteResource: (name, ns) =>
      commands.deletePersistentVolumeClaim(name, ns),
    defaultTab: "overview",
  });

  const connections = useConnections(
    ResourceType.PersistentVolumeClaim,
    name,
    namespace
  );

  // A claim with no volume behind it is a pod that will never start, and the
  // provisioner says why in the events rather than on the object.
  const pending = !!pvc && !pvc.volume;

  const {
    data: events = [],
    isLoading: eventsLoading,
    error: eventsError,
    refetch: refetchEvents,
  } = useLiveQuery({
    queryKey: ["pvc-events", namespace, name],
    queryFn: async () => {
      const filters: EventFilters = {
        namespace: namespace || null,
        involved_object_name: name || null,
        involved_object_kind: ResourceType.PersistentVolumeClaim,
        event_type: null,
        field_selector: null,
        limit: 100,
      };
      return await commands.listEvents(filters);
    },
    enabled: !!name && !!namespace,
    refresh: "overview",
  });

  const facts: KeyValue[] = [
    {
      label: t("columns", "capacity"),
      value: pvc?.capacity || t("empty", "notProvisionedYet"),
      mono: !!pvc?.capacity,
      tone: pvc?.capacity ? undefined : "warn",
    },
    {
      label: t("columns", "accessModes"),
      value: pvc?.accessModes.length
        ? pvc.accessModes.join(" · ")
        : t("empty", "noneLower"),
      mono: true,
    },
    {
      label: "Volume",
      value: pvc?.volume ? (
        <ResourceRef
          kind={ResourceType.PersistentVolume}
          name={pvc.volume}
          showKind={false}
        />
      ) : (
        t("empty", "notBoundNothingSatisfied")
      ),
      tone: pvc?.volume ? undefined : "warn",
    },
    {
      label: t("columns", "storageClass"),
      value: pvc?.storageClass ? (
        <ResourceRef
          kind={ResourceType.StorageClass}
          name={pvc.storageClass}
          showKind={false}
        />
      ) : (
        t("empty", "clusterDefault")
      ),
    },
  ];

  const deliveryQuery = deliveryOfKind(ResourceType.PersistentVolumeClaim, pvc);
  const intercept = useDeliveryIntercept(deliveryQuery);

  const tabs = [
    {
      id: "overview",
      label: t("nav", "overview"),
      glyph: viewGlyph(Info),
      content: (
        <KeyValueSection title="Claim" items={facts} className="max-w-lg" />
      ),
    },
    connectionsTab(connections, deliveryQuery),
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
                <DetailAction
                  label={t("action", "retry")}
                  onClick={() => refetchEvents()}
                />
              )
            }
          />
          {eventsError ? (
            <p className="text-xs text-warn">
              {t("empty", "couldNotReadClaimEvents")}
            </p>
          ) : eventsLoading ? (
            <div className="flex flex-col gap-1.5">
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-3/4" />
            </div>
          ) : (
            <EventRows
              events={events}
              emptyMessage={
                pending
                  ? t("empty", "noEventsUnprovisioned")
                  : t("empty", "noEventsForClaim")
              }
            />
          )}
        </Section>
      ),
    },
    yamlTab({
      title: t("action", "kindYaml", { kind: "PersistentVolumeClaim" }),
      yaml: pvcYaml,
      resourceKind: ResourceType.PersistentVolumeClaim,
      resourceName: name || "",
      namespace,
      onCopy: copyYaml,
    }),
  ];

  return (
    <ResourceDetailLayout
      freshness={freshness}
      resource={pvc}
      delivery={deliveryQuery}
      isLoading={isLoading}
      error={error}
      resourceKind={ResourceType.PersistentVolumeClaim}
      title={pvc?.name || name || ""}
      namespace={pvc?.namespace || namespace}
      statusBadge={pvc && <StatusBadge status={pvc.status} />}
      badges={
        pvc && (
          <>
            {pvc.capacity && (
              <span className="font-mono text-[11px] text-fg-mut">
                {pvc.capacity}
              </span>
            )}
            <span className="text-[11px] text-fg-fnt">
              {pvc.accessModes.join(" · ") || t("empty", "noAccessModes")}
            </span>
            {pending && (
              <span className="text-[11px] text-warn">
                {t("empty", "noVolumeBound")}
              </span>
            )}
          </>
        )
      }
      onBack={goBack}
      activeTab={activeTab}
      onTabChange={setActiveTab}
      tabs={tabs}
      actions={
        <InterceptedAction
          intercept={intercept("Delete")}
          label={t("action", "delete")}
          icon={Trash2}
          onClick={() => deleteMutation?.mutate()}
          busy={deleteMutation?.isPending}
          danger
        />
      }
    />
  );
}
