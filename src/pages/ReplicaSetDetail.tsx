import { useMemo } from "react";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
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
import { ResourceRef } from "@/components/resources/ResourceRef";
import {
  KeyValueSection,
  type KeyValue,
} from "@/components/resources/detail-kv";
import { recordToKeyValues } from "@/components/resources/key-values";
import { useResourceDetail } from "@/hooks";
import { commands } from "@/lib/commands";
import { declaredContainers } from "@/lib/container-sequence";
import { getResourceDetailUrl } from "@/lib/navigation-utils";
import { REFRESH_INTERVALS, STALE_TIMES } from "@/lib/refresh";
import { ResourceType, toPlural } from "@/lib/resource-registry";
import type { ReplicaSetInfo } from "@/generated/types";

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
  } = useResourceDetail<ReplicaSetInfo>({
    resourceKind: ResourceType.ReplicaSet,
    fetchResource: (name, ns) => commands.getReplicaset(name, ns),
    defaultTab: "overview",
  });

  const { data: pods = [] } = useQuery({
    queryKey: ["replicaset-pods", namespace, name],
    queryFn: () => commands.getReplicasetPods(name!, namespace || null),
    enabled: !!namespace && !!name,
    placeholderData: keepPreviousData,
    staleTime: STALE_TIMES.resourceList,
    refetchInterval: REFRESH_INTERVALS.resourceList,
  });

  const owner = replicaSet?.ownerReferences.find(
    (ref) => ref.controller && ref.kind === ResourceType.Deployment
  );

  // Only to say how many other revisions the Deployment is holding on to.
  // Without it a page that is empty because it was superseded looks exactly
  // like a page that is empty because nothing ever ran.
  const { data: siblings = [] } = useQuery({
    queryKey: ["deployment-replicasets", namespace, owner?.name],
    queryFn: () => commands.getDeploymentReplicasets(owner!.name, namespace!),
    enabled: !!owner && !!namespace,
    staleTime: STALE_TIMES.resourceList,
    refetchInterval: REFRESH_INTERVALS.resourceList,
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
    ? `Superseded by revision ${currentRevision}. The Deployment keeps this one at zero so a rollback can bring it straight back.`
    : "The Deployment is scaled to zero, so its current revision runs no pods.";
  const noPods = superseded
    ? `No pods — revision ${currentRevision} took over from this one.`
    : "No pods — the Deployment is scaled to zero.";

  const emptyPods = desired === 0 && current === 0;

  const facts: KeyValue[] = [
    {
      label: "Owned by",
      value: owner ? (
        <ResourceRef
          kind={ResourceType.Deployment}
          name={owner.name}
          namespace={replicaSet?.namespace}
          showKind={false}
        />
      ) : (
        "nothing — no Deployment is rolling this out"
      ),
    },
    {
      label: "Revision",
      value:
        revision === null ? (
          "none"
        ) : (
          <>
            {revision}
            {retired > 0 && (
              <span className="text-fg-fnt">
                {" "}
                · {retired} other{" "}
                {retired === 1 ? "revision is" : "revisions are"} scaled to zero
              </span>
            )}
          </>
        ),
      mono: revision !== null,
    },
    {
      label: "Containers",
      value: replicaSet ? declaredContainers(replicaSet).length : 0,
      mono: true,
    },
  ];

  const tabs = useMemo(
    () => [
      {
        id: "overview",
        label: "Overview",
        glyph: viewGlyph(Info),
        content: (
          <>
            <KeyValueSection
              title="Labels"
              count={Object.keys(replicaSet?.labels ?? {}).length}
              items={recordToKeyValues(replicaSet?.labels ?? {})}
              emptyMessage="No labels"
            />
            <KeyValueSection
              title="Annotations"
              count={Object.keys(replicaSet?.annotations ?? {}).length}
              items={recordToKeyValues(replicaSet?.annotations ?? {})}
              emptyMessage="No annotations"
            />
          </>
        ),
      },
      {
        id: "container-template",
        label: "Template",
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
            emptyMessage={
              emptyPods ? noPods : "This revision has no pods right now"
            }
          />
        ),
      },
      {
        id: "conditions",
        label: "Conditions",
        glyph: viewGlyph(BadgeCheck),
        mark: conditionsMark(replicaSet?.conditions),
        content: (
          <Section>
            <SectionHeader
              title="Conditions"
              count={replicaSet?.conditions.length}
            />
            <ConditionRows
              conditions={replicaSet?.conditions ?? []}
              emptyMessage="This ReplicaSet has raised nothing — it only reports a condition when it cannot create a pod."
              subject={{ kind: ResourceType.ReplicaSet, name, namespace }}
            />
          </Section>
        ),
      },
      yamlTab({
        yaml,
        onCopy: copyYaml,
        title: "ReplicaSet YAML",
        resourceKind: ResourceType.ReplicaSet,
        resourceName: replicaSet?.name || name || "",
        namespace: replicaSet?.namespace || namespace,
      }),
    ],
    [replicaSet, pods, yaml, copyYaml, namespace, name, emptyPods, noPods]
  );

  if (!replicaSet && !isLoading && !error) {
    return null;
  }

  return (
    <ResourceDetailLayout
      resource={replicaSet}
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
      title={replicaSet?.name || name || ""}
      namespace={replicaSet?.namespace || namespace}
      createdAt={replicaSet?.createdAt}
      statusBadge={
        replicaSet &&
        (standing === "unversioned" ? (
          <StatusBadge status={ready < desired ? "Degraded" : "Ready"}>
            {ready}/{desired} ready
          </StatusBadge>
        ) : (
          <StatusBadge
            status={standing === "current" ? "Current" : "Superseded"}
          >
            {standing === "current" ? "current revision" : "superseded"}
          </StatusBadge>
        ))
      }
      badges={
        replicaSet &&
        standing !== "unversioned" && (
          <span className="text-[11px] text-fg-fnt">
            {emptyPods ? "scaled to zero" : `${ready}/${desired} ready`}
          </span>
        )
      }
      onBack={goBack}
      tabs={tabs}
      activeTab={activeTab}
      onTabChange={setActiveTab}
    >
      <div className="grid gap-x-8 gap-y-[22px] md:grid-cols-2">
        <KeyValueSection title="Revision" items={facts} />
        <Section>
          <SectionHeader title="Replicas" />
          <Composition
            total={desired}
            label={desired === 1 ? "replica wanted" : "replicas wanted"}
            segments={[
              { label: "ready", count: ready, tone: "ok" },
              {
                label: "starting",
                count: Math.max(0, current - ready),
                tone: "warn",
              },
              {
                label: "not created",
                count: Math.max(0, desired - current),
                tone: "err",
              },
            ]}
            emptyMessage="scaled to zero"
            // A bar of nothing is the picture of a fault. The end of a
            // rollout looks identical, and only the sentence tells them
            // apart — so the empty case never renders without one.
            note={emptyPods ? whyEmpty : undefined}
          />
        </Section>
      </div>
    </ResourceDetailLayout>
  );
}
