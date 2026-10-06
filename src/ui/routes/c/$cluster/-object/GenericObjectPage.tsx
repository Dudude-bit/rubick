import { useRouter } from "@tanstack/react-router";
import { Info, Network } from "lucide-react";

import { EmptyPage } from "../../../-components/NotFound";
import { KeyValueSection } from "./detail-kv";
import { objectFacets } from "./facets";
import { OwnsPanel } from "./Owns";
import { useLineage } from "./ownership";
import { useOwnershipKeys } from "./ownership-keys";
import { ResourceDetailHeader } from "./ResourceDetailHeader";
import { yamlTab } from "./yaml-tab";
import { readTarget, servedOf, useServed, type Served } from "./served";
import { WordTable } from "./WordTable";
import { AccessPanel } from "./AccessPanel";
import { accessSegment } from "@/lib/access-kinds";
import { Section, SectionHeader } from "@/components/ui/section";
import { DetailTabs } from "@/components/object/DetailTabs";
import { StatusBadge } from "@/components/ui/status-badge";
import { DetailSkeleton } from "@/components/ui/skeleton";
import { viewGlyph, type DetailTab } from "@/components/object/detail-tab";
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";
import { useAppSearch, useSetSearch } from "@/hooks/useSearchParam";
import { useLiveQuery } from "@/hooks/useLiveQuery";
import { useT } from "@/i18n/useT";
import { commands } from "@/lib/commands";
import { errorCode, errorToShow } from "@/lib/error-utils";
import { resourceListLink } from "@/lib/links";
import { queryKeys } from "@/lib/query-keys";
import { STALE_TIMES } from "@/lib/refresh";
import { isResourceType, toKind } from "@/lib/resource-registry";
import { useClusterStore } from "@/stores/clusterStore";

/**
 * An object of any kind the cluster serves and no screen draws: what it says
 * about itself, as YAML. A missing object, a kind the cluster does not serve
 * and a discovery nobody could read are three pages; the catalogue tells
 * them apart, never the failed read alone.
 */
export function GenericObjectPage({
  resource,
  namespace,
  name,
}: {
  resource: string;
  namespace?: string;
  name: string;
}) {
  const t = useT();
  const router = useRouter();
  const copy = useCopyToClipboard();
  const isConnected = useClusterStore((state) => state.isConnected);
  const served = useServed(servedOf(resource));
  const read = readTarget(resource, served);
  const target = read ?? servedOf(resource);
  const yaml = useLiveQuery({
    queryKey: queryKeys.servedObjectYaml(
      target.group,
      target.plural,
      namespace,
      name
    ),
    queryFn: () =>
      commands.getServedObjectYaml(
        target.group,
        target.plural,
        name,
        namespace ?? null
      ),
    enabled: isConnected && read !== null,
    refresh: "resourceDetail",
    staleTime: STALE_TIMES.resourceDetail,
  });
  const object = useLiveQuery({
    queryKey: queryKeys.servedObject(
      target.group,
      target.plural,
      namespace,
      name
    ),
    queryFn: () =>
      commands.getServedObject(
        target.group,
        target.plural,
        name,
        namespace ?? null
      ),
    enabled: isConnected && read !== null,
    refresh: "resourceDetail",
    staleTime: STALE_TIMES.resourceDetail,
  });
  const facets = object.data
    ? objectFacets(
        object.data,
        t,
        served.state === "served" ? served.entry.hasStatus : undefined
      )
    : null;
  const registryKind = isResourceType(resource) ? toKind(resource) : null;
  const kind =
    served.state === "served" ? served.entry.kind : (registryKind ?? resource);
  const uid = useLineage(read, name, namespace).data?.uid ?? null;
  useOwnershipKeys(read, name, namespace);
  const activeTab = useAppSearch().tab ?? "overview";
  const setSearch = useSetSearch();

  const manifest = yamlTab({
    yaml: yaml.data,
    resourceKind: registryKind ?? undefined,
    resourceName: name,
    namespace,
    onCopy: () => yaml.data && copy(yaml.data),
  });
  const overview: DetailTab = {
    id: "overview",
    label: t("nav", "overview"),
    glyph: viewGlyph(Info),
    content: facets ? (
      <div className="flex flex-col gap-[22px]">
        {facets.groups.map((group) =>
          group.table ? (
            <Section key={group.title}>
              <SectionHeader title={group.title} count={group.count} />
              <WordTable
                table={group.table}
                emptyMessage={group.emptyMessage ?? t("empty", "noneLower")}
              />
            </Section>
          ) : (
            <KeyValueSection
              key={group.title}
              title={group.title}
              count={group.count}
              items={group.items}
              emptyMessage={group.emptyMessage ?? t("empty", "noneLower")}
            />
          )
        )}
        {accessSegment(kind) ===
          (target.group
            ? `${target.plural}.${target.group}`
            : target.plural) && (
          <Section>
            <AccessPanel
              kind={kind}
              name={name}
              namespace={namespace ?? null}
              heading={(title, count) => (
                <SectionHeader title={title} count={count} />
              )}
            />
          </Section>
        )}
      </div>
    ) : (
      <DetailSkeleton />
    ),
  };
  const tabs: DetailTab[] = uid
    ? [
        overview,
        {
          id: "owns",
          label: t("owns", "tab"),
          glyph: viewGlyph(Network),
          content: <OwnsPanel uid={uid} namespace={namespace} />,
        },
        manifest,
      ]
    : [overview, manifest];

  return (
    <div className="flex h-full flex-col gap-4">
      <ResourceDetailHeader
        kind={kind}
        name={name}
        namespace={namespace}
        listLink={resourceListLink(resource)}
        listLabel={resource}
        served={target}
        status={
          facets?.status ? (
            <StatusBadge status={facets.status}>{facets.status}</StatusBadge>
          ) : undefined
        }
        createdAt={facets?.createdAt}
        onBack={() => router.history.back()}
        dataUpdatedAt={yaml.dataUpdatedAt}
        slowed={yaml.freshness.slowed}
      />
      {object.isError && yaml.isError ? (
        <Unread
          error={object.error}
          served={served}
          resource={resource}
          kind={kind}
          name={name}
          t={t}
        />
      ) : (
        <DetailTabs
          tabs={tabs}
          activeTab={activeTab}
          onTabChange={(tab) =>
            setSearch({ tab: tab === "overview" ? undefined : tab })
          }
        />
      )}
    </div>
  );
}

function Unread({
  error,
  served,
  resource,
  kind,
  name,
  t,
}: {
  error: unknown;
  served: Served;
  resource: string;
  kind: string;
  name: string;
  t: ReturnType<typeof useT>;
}) {
  if (errorCode(error) !== "NOT_FOUND" || served.state === "reading")
    return (
      <EmptyPage title={t("empty", "objectUnread")} body={errorToShow(error)} />
    );
  if (served.state === "absent")
    return (
      <EmptyPage
        title={t("empty", "notServed", { resource })}
        body={t("empty", "notServedBody")}
      />
    );
  if (served.state === "unknown")
    return (
      <EmptyPage
        title={t("empty", "discoveryUnread", { resource })}
        body={t("empty", "discoveryUnreadBody", { error: served.error })}
      />
    );
  return (
    <EmptyPage
      title={t("empty", "objectMissing", { kind, name })}
      body={t("empty", "objectMissingBody")}
    />
  );
}
