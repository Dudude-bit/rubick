import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLiveQuery } from "@/hooks/useLiveQuery";
import { Activity, Info, Link2, ListTree, Tag, Trash2 } from "lucide-react";

import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Section, SectionHeader } from "@/components/ui/section";
import { StatusBadge } from "@/components/ui/status-badge";
import { useToast } from "@/components/ui/use-toast";
import { yamlTab } from "@/components/resources/yaml-tab";
import { ResourceDetailLayout } from "@/components/resources/ResourceDetailLayout";
import { viewGlyph, type DetailTab } from "@/components/resources/detail-tab";
import { ResourceRef } from "@/components/resources/ResourceRef";
import { RelatedPanel } from "@/components/resources/RelatedPanel";
import { countMark } from "@/components/resources/detail-tab";
import { useRelatedObjects } from "@/hooks/useRelatedObjects";
import {
  KeyValueSection,
  type KeyValue,
} from "@/components/resources/detail-kv";
import { recordToKeyValues } from "@/components/resources/key-values";
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";
import { commands } from "@/lib/commands";
import { deliveryOf } from "@/lib/delivery";
import { InterceptedAction } from "@/components/resources/delivery-intercept";
import { useDeliveryIntercept } from "@/hooks/useDelivery";
import { STALE_TIMES } from "@/lib/refresh";
import { ResourceType, toPlural } from "@/lib/resource-registry";
import { useClusterStore } from "@/stores/clusterStore";
import type { CustomResourceDetailInfo } from "@/generated/types";
import { useT } from "@/i18n/useT";

/**
 * A custom resource is whatever its author decided it is, so nothing on this
 * page may assume a shape. Every value is rendered from its JSON type alone:
 * leaves become one wrapping row, containers announce their size and nest
 * one hairline deeper. Indentation stops growing after six levels — a deeply
 * nested operator spec would otherwise push its own values off the right
 * edge, and a horizontal scrollbar hides exactly the end of the string the
 * reader came for.
 */
const MAX_INDENT_LEVEL = 6;

function isContainer(value: unknown): boolean {
  return (
    (Array.isArray(value) && value.length > 0) ||
    (typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      Object.keys(value as object).length > 0)
  );
}

function JsonLeaf({ value }: { value: unknown }) {
  const t = useT();
  if (value === null || value === undefined) {
    return <span className="text-fg-fnt">null</span>;
  }
  if (Array.isArray(value)) {
    return <span className="text-fg-fnt">{t("action", "emptyList")}</span>;
  }
  if (typeof value === "object") {
    return <span className="text-fg-fnt">{t("action", "emptyObject")}</span>;
  }
  return (
    <span className="wrap-break-word font-mono text-fg">{String(value)}</span>
  );
}

function JsonEntries({ data, depth }: { data: unknown; depth: number }) {
  const entries: [string, unknown][] = Array.isArray(data)
    ? data.map((item, index) => [`${index}`, item])
    : Object.entries(data as Record<string, unknown>);

  return (
    <div className={depth > 0 ? "border-l border-hair pl-2.5" : undefined}>
      {entries.map(([key, value]) => (
        <JsonRow key={key} label={key} value={value} depth={depth} />
      ))}
    </div>
  );
}

function JsonRow({
  label,
  value,
  depth,
}: {
  label: string;
  value: unknown;
  depth: number;
}) {
  const t = useT();
  if (!isContainer(value)) {
    return (
      <div className="grid grid-cols-[minmax(0,160px)_minmax(0,1fr)] items-baseline gap-3 border-b border-hair py-1 last:border-b-0">
        <span className="wrap-break-word text-[11px] text-fg-fnt">{label}</span>
        <span className="min-w-0 text-xs">
          <JsonLeaf value={value} />
        </span>
      </div>
    );
  }

  const size = Array.isArray(value)
    ? t("count", "items", { n: value.length })
    : t("count", "fields", { n: Object.keys(value as object).length });

  return (
    <div className="border-b border-hair py-1 last:border-b-0">
      <div className="flex items-baseline gap-2">
        <span className="wrap-break-word text-[11px] font-medium text-fg-mid">
          {label}
        </span>
        <span className="text-[11px] text-fg-fnt">{size}</span>
      </div>
      <div className="mt-0.5">
        <JsonEntries
          data={value}
          depth={Math.min(depth + 1, MAX_INDENT_LEVEL)}
        />
      </div>
    </div>
  );
}

/** The root of a spec or status block. */
function JsonTree({ data }: { data: unknown }) {
  if (!isContainer(data)) {
    return (
      <p className="py-1 text-xs">
        <JsonLeaf value={data} />
      </p>
    );
  }
  return <JsonEntries data={data} depth={0} />;
}

/**
 * Custom resources report health in whatever field their author picked.
 * These four cover cert-manager, Flux, Argo and most operators; anything
 * else simply gets no badge rather than a wrong one.
 */
function statusOf(resource: CustomResourceDetailInfo): string | null {
  if (!resource.status || typeof resource.status !== "object") return null;
  const status = resource.status as Record<string, unknown>;

  if (typeof status.phase === "string") return status.phase;
  if (typeof status.state === "string") return status.state;

  if (Array.isArray(status.conditions)) {
    const ready = status.conditions.find(
      (c: unknown) =>
        typeof c === "object" &&
        c !== null &&
        (c as Record<string, unknown>).type === "Ready"
    ) as Record<string, unknown> | undefined;
    if (ready) return ready.status === "True" ? "Ready" : "NotReady";
  }

  if (typeof status.ready === "boolean")
    return status.ready ? "Ready" : "NotReady";

  return null;
}

export function CustomResourceDetail() {
  const t = useT();
  const { crdName, namespace, name } = useParams<{
    crdName: string;
    namespace?: string;
    name: string;
  }>();
  const navigate = useNavigate();
  const { isConnected } = useClusterStore();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const copyToClipboard = useCopyToClipboard();
  const [activeTab, setActiveTab] = useState("overview");
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  const decodedCrdName = crdName ? decodeURIComponent(crdName) : "";

  const goBack = () => navigate(-1);

  const { data: crdInfo } = useQuery({
    queryKey: ["crd", decodedCrdName],
    queryFn: () => commands.getCrd(decodedCrdName),
    enabled: isConnected && !!decodedCrdName,
  });

  const {
    data: resource,
    isLoading,
    error,
  } = useLiveQuery({
    queryKey: ["custom-resource", decodedCrdName, namespace, name],
    queryFn: () =>
      commands.getCustomResource(decodedCrdName, name || "", namespace || null),
    enabled: isConnected && !!decodedCrdName && !!name,
    staleTime: STALE_TIMES.resourceDetail,
    refresh: "resourceDetail",
  });

  const { data: yaml = "" } = useQuery({
    queryKey: ["custom-resource-yaml", decodedCrdName, namespace, name],
    queryFn: () =>
      commands.getCustomResourceYaml(
        decodedCrdName,
        name || "",
        namespace || null
      ),
    enabled: isConnected && !!decodedCrdName && !!name,
    staleTime: STALE_TIMES.resourceDetail,
  });

  const deleteMutation = useMutation({
    mutationFn: () =>
      commands.deleteCustomResource(
        decodedCrdName,
        name || "",
        namespace || null
      ),
    onSuccess: () => {
      toast({
        title: t("action", "kindDeleted", {
          kind: crdInfo?.kind || t("action", "resourceNoun"),
        }),
        description: t("action", "nameDeleted", { name: name ?? "" }),
      });
      queryClient.invalidateQueries({
        queryKey: ["custom-resources", decodedCrdName],
      });
      navigate(-1);
    },
    onError: (error: Error) => {
      toast({
        title: t("action", "deleteKindFailed", {
          kind: crdInfo?.kind || t("action", "resourceNoun"),
        }),
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const status = resource ? statusOf(resource) : null;
  const owners = resource?.ownerReferences ?? [];
  const finalizers = resource?.finalizers ?? [];

  const facts: KeyValue[] = [
    { label: "API version", value: resource?.apiVersion ?? "—", mono: true },
    { label: "Kind", value: resource?.kind ?? "—", mono: true },
    { label: "UID", value: resource?.uid ?? "—", mono: true },
    ...(resource?.resourceVersion
      ? [
          {
            label: "Resource version",
            value: resource.resourceVersion,
            mono: true,
          },
        ]
      : []),
    {
      // The CRD is what says this object's shape, and it has a page of its
      // own. The label already says what it is, so the reference does not.
      label: t("columns", "definition"),
      value: (
        <ResourceRef
          kind={ResourceType.CustomResourceDefinition}
          name={decodedCrdName}
          showKind={false}
        />
      ),
    },
  ];

  const ownerItems: KeyValue[] = owners.map((owner) => ({
    label: `${owner.kind}${owner.controller ? " · controller" : ""}`,
    // An owner is often another custom resource, which has no route of its
    // own. Linking on a guessed plural would hand the user a dead end.
    value: (
      <ResourceRef
        kind={owner.kind}
        name={owner.name}
        namespace={resource?.namespace}
        showKind={false}
      />
    ),
  }));

  const deliveryQuery = crdInfo
    ? deliveryOf(crdInfo.group, crdInfo.kind, resource)
    : null;

  // The group is the CRD's, never the object's `apiVersion`: a CRD may serve
  // several versions and the group is the half that identifies the API.
  const related = useRelatedObjects(
    crdInfo && name
      ? {
          group: crdInfo.group,
          kind: crdInfo.kind,
          namespace: namespace ?? null,
          name,
        }
      : null,
    resource
  );

  const tabs: DetailTab[] = [
    {
      id: "overview",
      label: t("nav", "overview"),
      glyph: viewGlyph(Info),
      content: (
        <KeyValueSection
          title={t("columns", "object")}
          items={facts}
          className="max-w-lg"
        />
      ),
    },
    {
      id: "spec",
      label: "Spec",
      glyph: viewGlyph(ListTree),
      content: (
        <Section>
          <SectionHeader title="Spec" />
          {/* The guard is on the object, not on `spec` — this is "the read
              has not landed", which on a CRD the reader has never seen
              before is indistinguishable from "this kind has no spec". */}
          {resource ? (
            <JsonTree data={resource.spec} />
          ) : (
            <p className="text-xs text-fg-fnt">
              {t("empty", "customResourceNotRead")}
            </p>
          )}
        </Section>
      ),
    },
    ...(resource?.status != null
      ? [
          {
            id: "status",
            label: t("columns", "status"),
            glyph: viewGlyph(Activity),
            content: (
              <Section>
                <SectionHeader
                  title={t("columns", "status")}
                  count={status ?? undefined}
                />
                <JsonTree data={resource.status} />
              </Section>
            ),
          },
        ]
      : []),
    {
      id: "metadata",
      label: "Metadata",
      glyph: viewGlyph(Tag),
      content: (
        <>
          <KeyValueSection
            title={t("columns", "ownedBy")}
            count={owners.length || undefined}
            items={ownerItems}
            emptyMessage={t("empty", "noOwner")}
          />
          <KeyValueSection
            title={t("columns", "finalizers")}
            count={finalizers.length || undefined}
            items={finalizers.map((finalizer) => ({
              label: finalizer,
              value: t("action", "blocksDeletion"),
              mono: false,
            }))}
            emptyMessage={t("empty", "noFinalizers")}
          />
          <KeyValueSection
            title={t("columns", "labels")}
            count={Object.keys(resource?.labels ?? {}).length}
            items={recordToKeyValues(resource?.labels ?? {})}
            emptyMessage={t("empty", "noLabels")}
          />
          <KeyValueSection
            title={t("columns", "annotations")}
            count={Object.keys(resource?.annotations ?? {}).length}
            items={recordToKeyValues(resource?.annotations ?? {})}
            emptyMessage={t("empty", "noAnnotations")}
          />
        </>
      ),
    },
    {
      id: "connections",
      label: t("columns", "connections"),
      // A view rather than a kind, the same as every other Connections tab:
      // it opens onto whatever kinds this object happens to name.
      glyph: viewGlyph(Link2),
      mark: related.related.length
        ? countMark(related.related.length)
        : undefined,
      content: <RelatedPanel query={related} kind={crdInfo?.kind ?? "these"} />,
    },
    yamlTab({
      title: `${resource?.kind || "Resource"} YAML`,
      yaml,
      onCopy: () => copyToClipboard(yaml),
    }),
  ];

  // The group comes off the CRD rather than a lookup table, which is the whole
  // reason a custom resource can be asked at all: an `Application` is itself
  // delivered on an app-of-apps cluster, and nothing here has heard of one.
  const intercept = useDeliveryIntercept(deliveryQuery);

  return (
    <>
      <ResourceDetailLayout
        resource={resource}
        isLoading={isLoading}
        error={error}
        delivery={deliveryQuery}
        resourceKind={crdInfo?.kind || "Resource"}
        listUrl={`/${toPlural(ResourceType.CustomResourceDefinition)}/${encodeURIComponent(
          decodedCrdName
        )}`}
        listLabel={crdInfo?.kind || decodedCrdName}
        title={resource?.name || name || ""}
        namespace={resource?.namespace ?? undefined}
        createdAt={resource?.createdAt}
        statusBadge={status && <StatusBadge status={status} />}
        badges={
          resource && (
            <span className="font-mono text-[11px] text-fg-fnt">
              {resource.apiVersion}
            </span>
          )
        }
        onBack={goBack}
        actions={
          <InterceptedAction
            intercept={intercept("Delete")}
            label={t("action", "delete")}
            icon={Trash2}
            onClick={() => setDeleteDialogOpen(true)}
            busy={deleteMutation.isPending}
            danger
          />
        }
        tabs={tabs}
        activeTab={activeTab}
        onTabChange={setActiveTab}
      />

      <ConfirmDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        title={t("action", "deleteKindQuestion", {
          kind: crdInfo?.kind || t("action", "resourceNoun"),
        })}
        description={t("action", "willBeRemovedIrreversible", {
          name: name ?? "",
        })}
        confirmLabel={t("action", "delete")}
        confirmVariant="destructive"
        confirmDisabled={deleteMutation.isPending}
        onConfirm={() => {
          deleteMutation.mutate();
          setDeleteDialogOpen(false);
        }}
      />
    </>
  );
}
