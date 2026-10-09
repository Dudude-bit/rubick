import { useCallback } from "react";
import { DeleteAction } from "../../../-object/DeleteAction";
import { Info } from "lucide-react";

import type { ShareContribution } from "@/components/share/contribution";
import { pvcFactsSection, pvcStatusOf } from "@/lib/share/pvc-share";
import { PhaseBadge } from "@/components/ui/status-badge";
import { yamlTab } from "../../../-object/yaml-tab";
import { eventsTab } from "../../../-object/events-tab";
import { useObjectEvents } from "@/hooks/useObjectEvents";
import { ResourceDetailLayout } from "../../../-object/ResourceDetailLayout";
import { viewGlyph } from "@/components/object/detail-tab";
import { ResourceRef } from "@/components/object/ResourceRef";
import { KeyValueSection, type KeyValue } from "../../../-object/detail-kv";
import { connectionsTab } from "../../../-object/connections-tab";
import { useResourceDetail } from "@/hooks";
import { useObjectConnections } from "@/hooks/useConnections";
import { commands } from "@/lib/commands";
import { deliveryOfKind } from "@/lib/delivery";
import { useDeliveryIntercept } from "../../../-delivery/useDelivery";
import { ResourceType } from "@/lib/resource-registry";
import type { PersistentVolumeClaimInfo } from "@/generated/types";
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

  const connections = useObjectConnections(
    ResourceType.PersistentVolumeClaim,
    name,
    namespace
  );

  // A claim with no volume behind it is a pod that will never start, and the
  // provisioner says why in the events rather than on the object.
  const pending = !!pvc && !pvc.volume;

  const events = useObjectEvents(
    ResourceType.PersistentVolumeClaim,
    name,
    namespace,
    { refresh: "overview" }
  );

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

  const share = useCallback((): ShareContribution => {
    if (!pvc) return {};
    return {
      status: pvcStatusOf(pvc),
      sections: [pvcFactsSection(pvc, t)],
    };
  }, [pvc, t]);

  const tabs = [
    {
      id: "overview",
      label: t("nav", "overview"),
      glyph: viewGlyph(Info),
      content: (
        <KeyValueSection title="Claim" items={facts} className="max-w-lg" />
      ),
    },
    connectionsTab(connections, t, deliveryQuery),
    eventsTab(events, t, {
      kind: ResourceType.PersistentVolumeClaim,
      name: name ?? "",
      none: pending
        ? t("empty", "noEventsUnprovisioned")
        : t("empty", "noEventsForClaim"),
    }),
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
      share={share}
      delivery={deliveryQuery}
      isLoading={isLoading}
      error={error}
      resourceKind={ResourceType.PersistentVolumeClaim}
      title={pvc?.name || name || ""}
      namespace={pvc?.namespace || namespace}
      statusBadge={pvc && <PhaseBadge phase={pvc.status} />}
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
        <DeleteAction
          kind={ResourceType.PersistentVolumeClaim}
          name={pvc?.name || name || ""}
          namespace={pvc?.namespace || namespace}
          detail={pvc}
          intercept={intercept("Delete")}
          mutation={deleteMutation}
        />
      }
    />
  );
}
