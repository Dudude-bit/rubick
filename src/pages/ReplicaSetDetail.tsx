import { keepPreviousData } from "@tanstack/react-query";
import { useLiveQuery } from "@/hooks/useLiveQuery";
import { BadgeCheck, Info, Layers2 } from "lucide-react";

import { Section, SectionHeader } from "@/components/ui/section";
import { StatusBadge } from "@/components/ui/status-badge";
import { yamlTab } from "@/components/resources/yaml-tab";
import { PodListCard } from "@/components/resources/PodListCard";
import { ResourceDetailLayout } from "@/components/resources/ResourceDetailLayout";
import {
  conditionsMark,
  kindGlyph,
  podsMark,
  viewGlyph,
} from "@/components/resources/detail-tab";
import { ContainerRows } from "@/components/resources/container-rows";
import {
  Composition,
  ConditionRows,
} from "@/components/resources/detail-blocks";
import {
  CountBlock,
  FactBlock,
  WorkloadOverview,
} from "@/components/resources/workload-overview";
import { serviceAccountRow } from "@/components/resources/identity-rows";
import { ResourceRef } from "@/components/resources/ResourceRef";
import {
  KeyValueSection,
  type KeyValue,
} from "@/components/resources/detail-kv";
import { recordToKeyValues } from "@/components/resources/key-values";
import { useResourceDetail } from "@/hooks";
import { commands } from "@/lib/commands";
import { deliveryOfKind } from "@/lib/delivery";
import { getResourceDetailUrl } from "@/lib/navigation-utils";
import { STALE_TIMES } from "@/lib/refresh";
import { ResourceType, toPlural } from "@/lib/resource-registry";
import type { ReplicaSetInfo } from "@/generated/types";
import { useT } from "@/i18n/useT";

/**
 * One revision of a Deployment.
 *
 * There is no list page and no nav entry, on purpose: nobody opens a list of
 * ReplicaSets looking for one. You arrive from the event that scaled it, a
 * pod's owner chain, or a Deployment's revisions — and the question you
 * arrive with is always the same two, which is what this page is: *which
 * revision is this, and what is it doing.*
 */
export function ReplicaSetDetail() {
  const t = useT();
  const {
    name,
    namespace,
    resource: replicaSet,
    isLoading,
    error,
    yaml,
    copyYaml,
    activeTab,
    setActiveTab,
    goBack,
    freshness,
  } = useResourceDetail<ReplicaSetInfo>({
    resourceKind: ResourceType.ReplicaSet,
    fetchResource: (name, ns) => commands.getReplicaset(name, ns),
    defaultTab: "overview",
  });

  const { data: pods = [] } = useLiveQuery({
    queryKey: ["replicaset-pods", namespace, name],
    queryFn: () => commands.getReplicasetPods(name!, namespace || null),
    enabled: !!namespace && !!name,
    placeholderData: keepPreviousData,
    staleTime: STALE_TIMES.resourceList,
    refresh: "resourceList",
  });

  const owner = replicaSet?.ownerReferences.find(
    (ref) => ref.controller && ref.kind === ResourceType.Deployment
  );

  // Only to say how many other revisions the Deployment is holding on to.
  // Without it a page that is empty because it was superseded looks exactly
  // like a page that is empty because nothing ever ran.
  const { data: siblings = [] } = useLiveQuery({
    queryKey: ["deployment-replicasets", namespace, owner?.name],
    queryFn: () => commands.getDeploymentReplicasets(owner!.name, namespace!),
    enabled: !!owner && !!namespace,
    staleTime: STALE_TIMES.resourceList,
    refresh: "resourceList",
  });

  const replicas = replicaSet?.replicas;
  const desired = replicas?.desired ?? 0;
  const current = replicas?.current ?? 0;
  const ready = replicas?.ready ?? 0;

  const revision = replicaSet?.revision ?? null;
  const currentRevision = replicaSet?.currentRevision ?? null;
  // No owner, or an owner that writes no revision: there is no newer
  // revision for this one to be behind, so "current" is a question with no
  // answer rather than a no.
  const standing =
    currentRevision === null
      ? "unversioned"
      : revision === currentRevision
        ? "current"
        : "superseded";

  const retired = siblings.filter(
    (rs) => rs.replicas.desired === 0 && rs.name !== replicaSet?.name
  ).length;

  // Why there is nothing running here. Said twice because both places are on
  // screen at once — the short form beside the missing pods, the full one
  // under the bar — so neither is a verbatim echo of the other.
  const superseded = standing === "superseded";
  const whyEmpty = superseded
    ? t("empty", "supersededByRevision", { revision: currentRevision ?? "" })
    : t("empty", "deploymentScaledToZeroNote");
  const noPods = superseded
    ? t("empty", "noPodsSuperseded", { revision: currentRevision ?? "" })
    : t("empty", "noPodsScaledToZero");

  const emptyPods = desired === 0 && current === 0;

  const facts: KeyValue[] = [
    {
      label: t("columns", "ownedBy"),
      value: owner ? (
        <ResourceRef
          kind={ResourceType.Deployment}
          name={owner.name}
          namespace={replicaSet?.namespace}
          showKind={false}
        />
      ) : (
        t("empty", "noDeploymentRollingOut")
      ),
    },
    {
      label: t("columns", "revision"),
      value:
        revision === null ? (
          t("empty", "noneLower")
        ) : (
          <>
            {revision}
            {retired > 0 && (
              <span className="text-fg-fnt">
                {" "}
                · {t("count", "otherRevisionsAtZero", { n: retired })}
              </span>
            )}
          </>
        ),
      mono: revision !== null,
    },
    serviceAccountRow(replicaSet?.serviceAccountName, replicaSet?.namespace, t),
  ];

  const tabs = [
    {
      id: "overview",
      label: t("nav", "overview"),
      glyph: viewGlyph(Info),
      content: (
        <>
          <WorkloadOverview
            count={
              <CountBlock
                title={t("columns", "replicas")}
                subject={t("columns", "whatThisRevisionRuns")}
              >
                <Composition
                  total={desired}
                  label={t("count", "replicasWanted", { n: desired })}
                  segments={[
                    {
                      label: t("count", "readySegment"),
                      count: ready,
                      tone: "ok",
                    },
                    {
                      label: t("count", "startingSegment"),
                      count: Math.max(0, current - ready),
                      tone: "warn",
                    },
                    {
                      label: t("count", "notCreatedSegment"),
                      count: Math.max(0, desired - current),
                      tone: "err",
                    },
                  ]}
                  emptyMessage={t("empty", "scaledToZero")}
                  // A bar of nothing is the picture of a fault. The end of a
                  // rollout looks identical, and only the sentence tells them
                  // apart — so the empty case never renders without one.
                  note={emptyPods ? whyEmpty : undefined}
                />
              </CountBlock>
            }
            declared={
              <FactBlock title={t("columns", "revision")} items={facts} />
            }
          />

          <KeyValueSection
            title={t("columns", "labels")}
            count={Object.keys(replicaSet?.labels ?? {}).length}
            items={recordToKeyValues(replicaSet?.labels ?? {})}
            emptyMessage={t("empty", "noLabels")}
          />
          <KeyValueSection
            title={t("columns", "annotations")}
            count={Object.keys(replicaSet?.annotations ?? {}).length}
            items={recordToKeyValues(replicaSet?.annotations ?? {})}
            emptyMessage={t("empty", "noAnnotations")}
          />
        </>
      ),
    },
    {
      id: "container-template",
      label: t("nav", "template"),
      glyph: viewGlyph(Layers2),
      content: <ContainerRows template={replicaSet} namespace={namespace} />,
    },
    {
      id: toPlural(ResourceType.Pod),
      label: "Pods",
      glyph: kindGlyph(ResourceType.Pod),
      mark: podsMark(pods),
      content: (
        <PodListCard
          pods={pods}
          // "No pods" on a superseded revision reads as a fault. It is the
          // ordinary end of a rollout, and the page has to say so.
          emptyMessage={emptyPods ? noPods : t("empty", "revisionHasNoPods")}
        />
      ),
    },
    {
      id: "conditions",
      label: t("nav", "conditions"),
      glyph: viewGlyph(BadgeCheck),
      mark: conditionsMark(replicaSet?.conditions),
      content: (
        <Section>
          <SectionHeader
            title={t("columns", "conditions")}
            count={replicaSet?.conditions.length}
          />
          <ConditionRows
            conditions={replicaSet?.conditions ?? []}
            emptyMessage={t("empty", "noConditionsReplicaSet")}
            subject={{ kind: ResourceType.ReplicaSet, name, namespace }}
          />
        </Section>
      ),
    },
    yamlTab({
      yaml,
      onCopy: copyYaml,
      title: t("action", "kindYaml", { kind: "ReplicaSet" }),
      resourceKind: ResourceType.ReplicaSet,
      resourceName: replicaSet?.name || name || "",
      namespace: replicaSet?.namespace || namespace,
    }),
  ];

  if (!replicaSet && !isLoading && !error) {
    return null;
  }

  return (
    <ResourceDetailLayout
      freshness={freshness}
      resource={replicaSet}
      delivery={deliveryOfKind(ResourceType.ReplicaSet, replicaSet)}
      isLoading={isLoading}
      error={error}
      resourceKind={ResourceType.ReplicaSet}
      // The parent of a revision is the Deployment it is a revision of.
      // There is no list of ReplicaSets to offer instead, so without an
      // owner the segment says the kind and goes nowhere.
      listUrl={
        owner
          ? getResourceDetailUrl(
              ResourceType.Deployment,
              owner.name,
              replicaSet?.namespace
            )
          : null
      }
      listLabel={owner?.name}
      // And no list of them to narrow either: the namespace segment hands the
      // tab that scope and leaves the reader on the revision they opened.
      namespaceUrl={null}
      title={replicaSet?.name || name || ""}
      namespace={replicaSet?.namespace || namespace}
      createdAt={replicaSet?.createdAt}
      statusBadge={
        replicaSet &&
        (standing === "unversioned" ? (
          <StatusBadge status={ready < desired ? "Degraded" : "Ready"}>
            {t("count", "slashReady", { n: ready, total: desired })}
          </StatusBadge>
        ) : (
          <StatusBadge
            status={standing === "current" ? "Current" : "Superseded"}
          >
            {standing === "current"
              ? t("empty", "currentRevisionLower")
              : t("empty", "supersededLower")}
          </StatusBadge>
        ))
      }
      badges={
        replicaSet &&
        standing !== "unversioned" && (
          <span className="text-[11px] text-fg-fnt">
            {emptyPods
              ? t("empty", "scaledToZero")
              : t("count", "slashReady", { n: ready, total: desired })}
          </span>
        )
      }
      onBack={goBack}
      tabs={tabs}
      activeTab={activeTab}
      onTabChange={setActiveTab}
    />
  );
}
