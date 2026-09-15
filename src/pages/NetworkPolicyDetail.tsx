import { ArrowDownToLine, Info, Trash2 } from "lucide-react";

import { ResourceDetailLayout } from "@/components/resources/ResourceDetailLayout";
import { Peer } from "@/components/resources/network-policy-cells";
import { countMark, viewGlyph } from "@/components/resources/detail-tab";
import {
  KeyValueSection,
  type KeyValue,
} from "@/components/resources/detail-kv";
import { yamlTab } from "@/components/resources/yaml-tab";
import { InterceptedAction } from "@/components/resources/delivery-intercept";
import { Section, SectionHeader } from "@/components/ui/section";
import { useDeliveryIntercept } from "@/hooks/useDelivery";
import { useResourceDetail } from "@/hooks";
import { T } from "@/i18n/T";
import { useT } from "@/i18n/useT";
import { commands } from "@/lib/commands";
import { deliveryOfKind } from "@/lib/delivery";
import { directionFact, portText, reachOf } from "@/lib/network-policy";
import { ResourceType } from "@/lib/resource-registry";
import type {
  NetworkPolicyInfo,
  PolicyDirection,
  PolicyRule,
} from "@/generated/types";

function Rule({ rule, outbound }: { rule: PolicyRule; outbound: boolean }) {
  const t = useT();
  return (
    <div className="flex flex-col gap-1 border-b border-hair py-2 last:border-b-0">
      <div className="flex flex-col gap-0.5 text-[12px]">
        {rule.peers.length === 0 ? (
          // No peer is not "no source": it is every source, and it is the
          // shape a policy takes when somebody meant to restrict and left the
          // list empty. Which word depends on the direction — the English is
          // the same shape both ways and the Russian is not.
          <span className="text-warn">
            {t("empty", outbound ? "toAnywhere" : "fromAnywhere")}
          </span>
        ) : (
          rule.peers.map((peer, i) => <Peer key={i} peer={peer} />)
        )}
      </div>
      <div className="text-[11px] text-fg-fnt">
        {rule.ports.length === 0
          ? t("empty", "everyPort")
          : rule.ports.map((port) => portText(port, t)).join(", ")}
      </div>
    </div>
  );
}

function Direction({
  title,
  direction,
  outbound,
}: {
  title: string;
  direction: PolicyDirection;
  outbound: boolean;
}) {
  const t = useT();
  const fact = directionFact(direction, t);
  return (
    <Section>
      <SectionHeader title={title} />
      {direction.rules.length === 0 ? (
        <p
          className={`text-[12px] ${fact.tone === "warn" ? "text-warn" : "text-fg-mut"}`}
        >
          {fact.value}
        </p>
      ) : (
        direction.rules.map((rule, i) => (
          <Rule key={i} rule={rule} outbound={outbound} />
        ))
      )}
    </Section>
  );
}

export function NetworkPolicyDetail() {
  const t = useT();
  const {
    name,
    namespace,
    resource: policy,
    isLoading,
    error,
    yaml,
    copyYaml,
    activeTab,
    setActiveTab,
    goBack,
    deleteMutation,
    freshness,
  } = useResourceDetail<NetworkPolicyInfo>({
    resourceKind: ResourceType.NetworkPolicy,
    fetchResource: (name, namespace) =>
      commands.getNetworkPolicy(name, namespace),
    deleteResource: async (name, namespace) => {
      await commands.deleteNetworkPolicy(name, namespace);
    },
    defaultTab: "overview",
  });

  const reach = policy ? reachOf(policy.selected) : null;
  const facts: KeyValue[] = policy
    ? [
        {
          label: t("columns", "selects"),
          value:
            policy.selects.kind === "written"
              ? policy.selects.query
              : policy.selects.kind === "everything"
                ? t("empty", "everyPodHere")
                : t("empty", "noSelectorOnPolicy"),
          mono: policy.selects.kind === "written",
        },
        {
          label: t("columns", "pods"),
          // Three answers, because a pod list the reader was refused is not
          // a policy with nothing behind it.
          value:
            reach?.kind === "cannotSay"
              ? t("empty", "podsNotRead")
              : reach?.kind === "nothing"
                ? t("empty", "selectsNoPods")
                : t("count", "pods", { n: reach?.count ?? 0 }),
          tone: reach?.kind === "nothing" ? "warn" : undefined,
        },
        {
          label: "Ingress",
          ...directionFact(policy.ingress, t),
        },
        {
          label: "Egress",
          ...directionFact(policy.egress, t),
        },
      ]
    : [];

  const deliveryQuery = deliveryOfKind(ResourceType.NetworkPolicy, policy);
  const intercept = useDeliveryIntercept(deliveryQuery);
  // Only the rules the tab draws. A policy carrying an `ingress:` block that
  // `policyTypes` does not name keeps those rules on the object, and counting
  // them promised a reader rules the tab then refuses to show.
  const ruleCount = [policy?.ingress, policy?.egress]
    .filter((direction) => direction?.governed)
    .reduce((n, direction) => n + (direction?.rules.length ?? 0), 0);

  const tabs = [
    {
      id: "overview",
      label: t("nav", "overview"),
      glyph: viewGlyph(Info),
      content: (
        <KeyValueSection
          title={t("columns", "selector")}
          items={facts}
          className="max-w-lg"
        />
      ),
    },
    {
      id: "rules",
      label: t("columns", "rules"),
      glyph: viewGlyph(ArrowDownToLine),
      mark: countMark(ruleCount),
      content: policy && (
        <div className="flex flex-col gap-4">
          {!policy.ingress.governed && !policy.egress.governed ? (
            <p className="text-[12px] text-fg-mut">
              <T section="empty" k="governsNeither" />
            </p>
          ) : (
            <>
              {policy.ingress.governed && (
                <Direction
                  title="Ingress"
                  direction={policy.ingress}
                  outbound={false}
                />
              )}
              {policy.egress.governed && (
                <Direction title="Egress" direction={policy.egress} outbound />
              )}
            </>
          )}
        </div>
      ),
    },
    yamlTab({
      title: t("action", "kindYaml", { kind: "NetworkPolicy" }),
      yaml,
      resourceKind: ResourceType.NetworkPolicy,
      resourceName: name || "",
      namespace,
      onCopy: copyYaml,
    }),
  ];

  return (
    <ResourceDetailLayout
      freshness={freshness}
      resource={policy}
      delivery={deliveryQuery}
      isLoading={isLoading}
      error={error}
      resourceKind={ResourceType.NetworkPolicy}
      title={policy?.name || name || ""}
      namespace={namespace}
      badges={
        policy && (
          // Each half keeps its own tone: "allows all" is the one verdict
          // the colour exists for, and a fixed muted span dropped it here
          // while the row and the fact below it both painted it.
          <span className="text-[11px]">
            {[policy.ingress, policy.egress]
              .map((direction) => directionFact(direction, t))
              .map((fact, i) => (
                <span key={i}>
                  {i > 0 && <span className="text-fg-fnt"> · </span>}
                  <span
                    className={
                      fact.tone === "warn" ? "text-warn" : "text-fg-mut"
                    }
                  >
                    {fact.value}
                  </span>
                </span>
              ))}
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
