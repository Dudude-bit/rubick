/**
 * A GatewayClass, read as a claim: which controller answered for the name,
 * in the three honest states — claimed, refused, and the one that ruins
 * clusters quietly, a class nothing ever answered for. Below the claim,
 * the blast radius: every Gateway that names this class, because that is
 * what the reader deletes with it.
 */

import { Info, Tag, Trash2 } from "lucide-react";

import { yamlTab } from "@/components/resources/yaml-tab";
import { ResourceDetailLayout } from "@/components/resources/ResourceDetailLayout";
import { viewGlyph } from "@/components/resources/detail-tab";
import {
  KeyValueSection,
  type KeyValue,
} from "@/components/resources/detail-kv";
import { recordToKeyValues } from "@/components/resources/key-values";
import { ResourceRef } from "@/components/resources/ResourceRef";
import { Section, SectionHeader } from "@/components/ui/section";
import { CopyableAddresses } from "@/components/ui/copyable-value";
import { InterceptedAction } from "@/components/resources/delivery-intercept";
import { useResourceDetail } from "@/hooks";
import { useDeliveryIntercept } from "@/hooks/useDelivery";
import { useLiveQuery } from "@/hooks/useLiveQuery";
import { commands } from "@/lib/commands";
import { deliveryOfKind } from "@/lib/delivery";
import { ResourceType } from "@/lib/resource-registry";
import type { GatewayClassInfo } from "@/generated/types";

/** A minute: routing changes with a deploy, not by the second. */
const ROUTING_STALE = 60_000;

function GatewayRows({ className }: { className: string }) {
  const {
    data: gateways,
    error,
    isLoading,
  } = useLiveQuery({
    queryKey: ["gateway-map-gateways"],
    queryFn: () => commands.listGateways(null),
    staleTime: ROUTING_STALE,
    refresh: "overview",
  });

  const users = (gateways ?? []).filter(
    (gateway) => gateway.className === className
  );

  return (
    <Section>
      <SectionHeader title="Gateways using it" count={users.length} />
      {error && gateways === undefined ? (
        <p className="text-xs text-err">
          Could not read the gateways: {(error as Error).message}
        </p>
      ) : isLoading && gateways === undefined ? (
        <p className="text-xs text-fg-fnt">Reading gateways…</p>
      ) : users.length === 0 ? (
        <p className="text-xs text-fg-fnt">
          No Gateway names this class — deleting it breaks nothing today.
        </p>
      ) : (
        <div className="space-y-1">
          {users.map((gateway) => (
            <div
              key={`${gateway.namespace}/${gateway.name}`}
              className="flex items-baseline gap-2 text-xs"
            >
              <ResourceRef
                kind={ResourceType.Gateway}
                name={gateway.name}
                namespace={gateway.namespace}
                showNamespace
              />
              <CopyableAddresses
                values={gateway.addresses}
                label="Gateway address"
                empty="no address"
                className="text-fg-fnt"
              />
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

export function GatewayClassDetail() {
  const {
    name,
    resource: cls,
    isLoading,
    error,
    yaml,
    copyYaml,
    activeTab,
    setActiveTab,
    goBack,
    deleteMutation,
    freshness,
  } = useResourceDetail<GatewayClassInfo>({
    resourceKind: ResourceType.GatewayClass,
    isClusterScoped: true,
    fetchResource: (name) => commands.getGatewayClass(name),
    deleteResource: (name) => commands.deleteGatewayClass(name),
    defaultTab: "overview",
  });

  const claim: KeyValue =
    cls?.accepted === true
      ? { label: "Claim", value: `claimed by ${cls.controllerName}` }
      : cls?.accepted === false
        ? {
            label: "Claim",
            value: `refused by ${cls.controllerName}`,
            tone: "err",
          }
        : {
            label: "Claim",
            value:
              "no controller has answered — everything through this class is dead",
            tone: "warn",
          };

  const facts: KeyValue[] = [
    { label: "Controller", value: cls?.controllerName ?? "—", mono: true },
    claim,
    ...(cls?.description
      ? [{ label: "Description", value: cls.description }]
      : []),
  ];

  const deliveryQuery = deliveryOfKind(ResourceType.GatewayClass, cls);
  const intercept = useDeliveryIntercept(deliveryQuery);

  const conditions: KeyValue[] = (cls?.conditions ?? []).map((condition) => ({
    label: condition.type,
    value: [condition.status, condition.reason, condition.message]
      .filter(Boolean)
      .join(" — "),
    tone: condition.status === "False" ? ("err" as const) : undefined,
  }));

  const tabs = [
    {
      id: "overview",
      label: "Overview",
      glyph: viewGlyph(Info),
      content: (
        <>
          <KeyValueSection
            title="GatewayClass"
            items={facts}
            className="max-w-lg"
          />
          {conditions.length > 0 && (
            <KeyValueSection
              title="Conditions"
              items={conditions}
              className="max-w-lg"
            />
          )}
          {name && <GatewayRows className={name} />}
        </>
      ),
    },
    {
      id: "metadata",
      label: "Metadata",
      glyph: viewGlyph(Tag),
      content: (
        <>
          <KeyValueSection
            title="Labels"
            count={Object.keys(cls?.labels ?? {}).length}
            items={recordToKeyValues(cls?.labels ?? {})}
            emptyMessage="No labels"
          />
          <KeyValueSection
            title="Annotations"
            count={Object.keys(cls?.annotations ?? {}).length}
            items={recordToKeyValues(cls?.annotations ?? {})}
            emptyMessage="No annotations"
          />
        </>
      ),
    },
    yamlTab({
      title: "GatewayClass YAML",
      yaml,
      resourceKind: ResourceType.GatewayClass,
      resourceName: name || "",
      namespace: undefined,
      onCopy: copyYaml,
    }),
  ];

  return (
    <ResourceDetailLayout
      freshness={freshness}
      resource={cls}
      delivery={deliveryQuery}
      isLoading={isLoading}
      error={error}
      resourceKind={ResourceType.GatewayClass}
      title={cls?.name || name || ""}
      createdAt={cls?.createdAt}
      badges={
        cls && (
          <span className="font-mono text-[11px] text-fg-mut">
            {cls.controllerName}
          </span>
        )
      }
      onBack={goBack}
      activeTab={activeTab}
      onTabChange={setActiveTab}
      tabs={tabs}
      actions={
        <InterceptedAction
          intercept={intercept("Delete")}
          label="Delete"
          icon={Trash2}
          onClick={() => deleteMutation?.mutate()}
          busy={deleteMutation?.isPending}
          danger
        />
      }
    />
  );
}
