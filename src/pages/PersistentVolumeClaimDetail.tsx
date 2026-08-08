import { useQuery } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";

import { Section, SectionHeader } from "@/components/ui/section";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { yamlTab } from "@/components/resources/yaml-tab";
import { ResourceDetailLayout } from "@/components/resources/ResourceDetailLayout";
import { countMark, kindGlyph } from "@/components/resources/detail-tab";
import { DetailAction, EventRows } from "@/components/resources/detail-blocks";
import { ResourceRef } from "@/components/resources/ResourceRef";
import {
  KeyValueSection,
  type KeyValue,
} from "@/components/resources/detail-kv";
import { useResourceDetail } from "@/hooks";
import { commands } from "@/lib/commands";
import { REFRESH_INTERVALS } from "@/lib/refresh";
import { ResourceType } from "@/lib/resource-registry";
import type {
  EventFilters,
  PersistentVolumeClaimInfo,
} from "@/generated/types";

export function PersistentVolumeClaimDetail() {
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
  } = useResourceDetail<PersistentVolumeClaimInfo>({
    resourceKind: ResourceType.PersistentVolumeClaim,
    fetchResource: (name, ns) => commands.getPersistentVolumeClaim(name, ns),
    deleteResource: (name, ns) =>
      commands.deletePersistentVolumeClaim(name, ns),
    defaultTab: "events",
  });

  // A claim with no volume behind it is a pod that will never start, and the
  // provisioner says why in the events rather than on the object.
  const pending = !!pvc && !pvc.volume;

  const {
    data: events = [],
    isLoading: eventsLoading,
    error: eventsError,
    refetch: refetchEvents,
  } = useQuery({
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
    refetchInterval: REFRESH_INTERVALS.overview,
  });

  const facts: KeyValue[] = [
    {
      label: "Capacity",
      value: pvc?.capacity || "not provisioned yet",
      mono: !!pvc?.capacity,
      tone: pvc?.capacity ? undefined : "warn",
    },
    {
      label: "Access modes",
      value: pvc?.accessModes.length ? pvc.accessModes.join(" · ") : "none",
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
        "not bound — nothing has satisfied this claim"
      ),
      tone: pvc?.volume ? undefined : "warn",
    },
    {
      label: "Storage class",
      value: pvc?.storageClass ? (
        <ResourceRef
          kind={ResourceType.StorageClass}
          name={pvc.storageClass}
          showKind={false}
        />
      ) : (
        "cluster default"
      ),
    },
  ];

  const tabs = [
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
              Could not read events for this claim.
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
                  ? "No events yet — no provisioner has picked this claim up."
                  : "No events for this claim"
              }
            />
          )}
        </Section>
      ),
    },
    yamlTab({
      title: "PersistentVolumeClaim YAML",
      yaml: pvcYaml,
      resourceKind: ResourceType.PersistentVolumeClaim,
      resourceName: name || "",
      namespace,
      onCopy: copyYaml,
    }),
  ];

  return (
    <ResourceDetailLayout
      resource={pvc}
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
              {pvc.accessModes.join(" · ") || "no access modes"}
            </span>
            {pending && (
              <span className="text-[11px] text-warn">no volume bound</span>
            )}
          </>
        )
      }
      onBack={goBack}
      activeTab={activeTab}
      onTabChange={setActiveTab}
      tabs={tabs}
      actions={
        <DetailAction
          label="Delete"
          icon={Trash2}
          onClick={() => deleteMutation?.mutate()}
          busy={deleteMutation?.isPending}
          danger
        />
      }
    >
      <KeyValueSection title="Claim" items={facts} className="max-w-lg" />
    </ResourceDetailLayout>
  );
}
