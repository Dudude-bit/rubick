import { useCallback } from "react";
import { DeleteAction } from "../../../-object/DeleteAction";
import { Info } from "lucide-react";

import type { ShareContribution } from "@/components/share/contribution";
import { pvFactsSection, pvStatusOf } from "@/lib/share/pv-share";
import { PhaseBadge } from "@/components/ui/status-badge";
import { yamlTab } from "../../../-object/yaml-tab";
import { connectionsTab } from "../../../-object/connections-tab";
import { viewGlyph } from "@/components/object/detail-tab";
import { ResourceDetailLayout } from "../../../-object/ResourceDetailLayout";
import { ResourceRef } from "@/components/object/ResourceRef";
import { KeyValueSection, type KeyValue } from "../../../-object/detail-kv";
import { ClaimRef } from "../../../-object/storage-refs";
import { useResourceDetail } from "@/hooks";
import { useConnections } from "@/hooks/useConnections";
import { commands } from "@/lib/commands";
import { deliveryOfKind } from "@/lib/delivery";
import { useDeliveryIntercept } from "../../../-delivery/useDelivery";
import { ResourceType } from "@/lib/resource-registry";
import type { PersistentVolumeInfo } from "@/generated/types";
import { useT } from "@/i18n/useT";
import { None } from "@/components/ui/none";

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
    {
      label: t("columns", "capacity"),
      value: pv?.capacity ?? <None />,
      mono: true,
    },
    {
      label: t("columns", "accessModes"),
      value: pv?.accessModes.length ? pv.accessModes.join(" · ") : <None />,
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
        <None />
      ),
    },
    {
      label: t("columns", "reclaimPolicy"),
      value: pv?.reclaimPolicy ?? <None />,
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

  const share = useCallback((): ShareContribution => {
    if (!pv) return {};
    return {
      status: pvStatusOf(pv),
      sections: [pvFactsSection(pv, t)],
    };
  }, [pv, t]);

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
      share={share}
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
        <DeleteAction
          kind={ResourceType.PersistentVolume}
          name={pv?.name || name || ""}
          detail={pv}
          intercept={intercept("Delete")}
          mutation={deleteMutation}
        />
      }
    />
  );
}
