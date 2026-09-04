import { Info, Trash2 } from "lucide-react";

import { PhaseBadge } from "@/components/ui/status-badge";
import { yamlTab } from "@/components/resources/yaml-tab";
import { connectionsTab } from "@/components/resources/connections-tab";
import { viewGlyph } from "@/components/resources/detail-tab";
import { ResourceDetailLayout } from "@/components/resources/ResourceDetailLayout";
import { ResourceRef } from "@/components/resources/ResourceRef";
import {
  KeyValueSection,
  type KeyValue,
} from "@/components/resources/detail-kv";
import { ClaimRef } from "@/components/resources/storage-refs";
import { useResourceDetail } from "@/hooks";
import { useConnections } from "@/hooks/useConnections";
import { commands } from "@/lib/commands";
import { deliveryOfKind } from "@/lib/delivery";
import { InterceptedAction } from "@/components/resources/delivery-intercept";
import { useDeliveryIntercept } from "@/hooks/useDelivery";
import { ResourceType } from "@/lib/resource-registry";
import type { PersistentVolumeInfo } from "@/generated/types";
import { useT } from "@/i18n/useT";

export function PersistentVolumeDetail() {
  const t = useT();
  const {
    name,
    resource: pv,
    isLoading,
    error,
    yaml: pvYaml,
    copyYaml,
    activeTab,
    setActiveTab,
    goBack,
    deleteMutation,
    freshness,
  } = useResourceDetail<PersistentVolumeInfo>({
    resourceKind: ResourceType.PersistentVolume,
    isClusterScoped: true,
    fetchResource: (name) => commands.getPersistentVolume(name),
    deleteResource: (name) => commands.deletePersistentVolume(name),
    defaultTab: "overview",
  });

  const facts: KeyValue[] = [
    { label: t("columns", "capacity"), value: pv?.capacity ?? "—", mono: true },
    {
      label: t("columns", "accessModes"),
      value: pv?.accessModes.length
        ? pv.accessModes.join(" · ")
        : t("empty", "none"),
      mono: true,
    },
    {
      label: "Claim",
      // A volume with no claim is storage nobody is using — the one fact on
      // this page that is worth a colour. Bound is the correct, quiet case.
      value: pv?.claim ? (
        <ClaimRef claim={pv.claim} />
      ) : (
        t("empty", "pvUnbound")
      ),
      tone: pv?.claim ? undefined : "warn",
    },
    {
      label: t("columns", "storageClass"),
      value: pv?.storageClass ? (
        <ResourceRef
          kind={ResourceType.StorageClass}
          name={pv.storageClass}
          showKind={false}
        />
      ) : (
        t("empty", "none")
      ),
    },
    {
      label: t("columns", "reclaimPolicy"),
      value: pv?.reclaimPolicy ?? "—",
      mono: true,
    },
    ...(pv?.reason
      ? [{ label: "Reason", value: pv.reason, tone: "err" as const }]
      : []),
  ];

  const deliveryQuery = deliveryOfKind(ResourceType.PersistentVolume, pv);
  const intercept = useDeliveryIntercept(deliveryQuery);
  // Cluster-scoped, and the claim it names is in a namespace of its own. The
  // block above links to that claim; this says whether it is still there and
  // what it says about itself, which a link cannot.
  const connections = useConnections(ResourceType.PersistentVolume, name, null);

  const tabs = [
    {
      id: "overview",
      label: t("nav", "overview"),
      glyph: viewGlyph(Info),
      content: (
        <KeyValueSection title="Volume" items={facts} className="max-w-lg" />
      ),
    },
    connectionsTab(connections, t, deliveryQuery),
    yamlTab({
      title: t("action", "kindYaml", { kind: "PersistentVolume" }),
      yaml: pvYaml,
      resourceKind: ResourceType.PersistentVolume,
      resourceName: name || "",
      namespace: undefined,
      onCopy: copyYaml,
    }),
  ];

  return (
    <ResourceDetailLayout
      freshness={freshness}
      resource={pv}
      delivery={deliveryQuery}
      isLoading={isLoading}
      error={error}
      resourceKind={ResourceType.PersistentVolume}
      title={pv?.name || name || ""}
      statusBadge={pv && <PhaseBadge phase={pv.status} />}
      badges={
        pv && (
          <>
            <span className="font-mono text-[11px] text-fg-mut">
              {pv.capacity}
            </span>
            <span className="text-[11px] text-fg-fnt">
              {pv.accessModes.join(" · ") || t("empty", "noAccessModes")}
            </span>
            {!pv.claim && (
              <span className="text-[11px] text-warn">
                {t("action", "unbound")}
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
