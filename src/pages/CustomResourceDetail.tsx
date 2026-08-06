import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";

import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Section, SectionHeader } from "@/components/ui/section";
import { StatusBadge } from "@/components/ui/status-badge";
import { useToast } from "@/components/ui/use-toast";
import { yamlTab } from "@/components/resources/yaml-tab";
import {
  ResourceDetailLayout,
  type DetailTab,
} from "@/components/resources/ResourceDetailLayout";
import { DetailAction } from "@/components/resources/detail-blocks";
import { ResourceRef } from "@/components/resources/ResourceRef";
import {
  KeyValueSection,
  type KeyValue,
} from "@/components/resources/detail-kv";
import { recordToKeyValues } from "@/components/resources/key-values";
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";
import { commands } from "@/lib/commands";
import { REFRESH_INTERVALS, STALE_TIMES } from "@/lib/refresh";
import { ResourceType, toPlural } from "@/lib/resource-registry";
import { useClusterStore } from "@/stores/clusterStore";
import type { CustomResourceDetailInfo } from "@/generated/types";

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
  if (value === null || value === undefined) {
    return <span className="text-fg-fnt">null</span>;
  }
  if (Array.isArray(value)) {
    return <span className="text-fg-fnt">empty list</span>;
  }
  if (typeof value === "object") {
    return <span className="text-fg-fnt">empty object</span>;
  }
  return <span className="break-words font-mono text-fg">{String(value)}</span>;
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
  if (!isContainer(value)) {
    return (
      <div className="grid grid-cols-[minmax(0,160px)_minmax(0,1fr)] items-baseline gap-3 border-b border-hair py-1 last:border-b-0">
        <span className="break-words text-[11px] text-fg-fnt">{label}</span>
        <span className="min-w-0 text-xs">
          <JsonLeaf value={value} />
        </span>
      </div>
    );
  }

  const size = Array.isArray(value)
    ? `${value.length} item${value.length === 1 ? "" : "s"}`
    : `${Object.keys(value as object).length} field${
        Object.keys(value as object).length === 1 ? "" : "s"
      }`;

  return (
    <div className="border-b border-hair py-1 last:border-b-0">
      <div className="flex items-baseline gap-2">
        <span className="break-words text-[11px] font-medium text-fg-mid">
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
  const [activeTab, setActiveTab] = useState("spec");
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
  } = useQuery({
    queryKey: ["custom-resource", decodedCrdName, namespace, name],
    queryFn: () =>
      commands.getCustomResource(decodedCrdName, name || "", namespace || null),
    enabled: isConnected && !!decodedCrdName && !!name,
    staleTime: STALE_TIMES.resourceDetail,
    refetchInterval: REFRESH_INTERVALS.resourceDetail,
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
        title: `${crdInfo?.kind || "Resource"} deleted`,
        description: `${name} has been deleted.`,
      });
      queryClient.invalidateQueries({
        queryKey: ["custom-resources", decodedCrdName],
      });
      navigate(-1);
    },
    onError: (error: Error) => {
      toast({
        title: `Failed to delete ${crdInfo?.kind || "resource"}`,
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
      label: "Definition",
      value: decodedCrdName,
      mono: true,
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

  const tabs: DetailTab[] = [
    {
      id: "spec",
      label: "Spec",
      content: (
        <Section>
          <SectionHeader title="Spec" />
          {resource ? (
            <JsonTree data={resource.spec} />
          ) : (
            <p className="text-xs text-fg-fnt">No spec</p>
          )}
        </Section>
      ),
    },
    ...(resource?.status != null
      ? [
          {
            id: "status",
            label: "Status",
            content: (
              <Section>
                <SectionHeader title="Status" count={status ?? undefined} />
                <JsonTree data={resource.status} />
              </Section>
            ),
          },
        ]
      : []),
    {
      id: "metadata",
      label: "Metadata",
      content: (
        <>
          <KeyValueSection
            title="Owned by"
            count={owners.length || undefined}
            items={ownerItems}
            emptyMessage="Nothing owns this object — it was created directly."
          />
          <KeyValueSection
            title="Finalizers"
            count={finalizers.length || undefined}
            items={finalizers.map((finalizer) => ({
              label: finalizer,
              value: "blocks deletion until cleared",
              mono: false,
            }))}
            emptyMessage="No finalizers"
          />
          <KeyValueSection
            title="Labels"
            count={Object.keys(resource?.labels ?? {}).length}
            items={recordToKeyValues(resource?.labels ?? {})}
            emptyMessage="No labels"
          />
          <KeyValueSection
            title="Annotations"
            count={Object.keys(resource?.annotations ?? {}).length}
            items={recordToKeyValues(resource?.annotations ?? {})}
            emptyMessage="No annotations"
          />
        </>
      ),
    },
    yamlTab({
      title: `${resource?.kind || "Resource"} YAML`,
      yaml,
      onCopy: () => copyToClipboard(yaml),
    }),
  ];

  return (
    <>
      <ResourceDetailLayout
        resource={resource}
        isLoading={isLoading}
        error={error}
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
          <DetailAction
            label="Delete"
            icon={Trash2}
            onClick={() => setDeleteDialogOpen(true)}
            busy={deleteMutation.isPending}
            danger
          />
        }
        tabs={tabs}
        activeTab={activeTab}
        onTabChange={setActiveTab}
      >
        <KeyValueSection title="Object" items={facts} className="max-w-lg" />
      </ResourceDetailLayout>

      <ConfirmDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        title={`Delete ${crdInfo?.kind || "resource"}?`}
        description={`"${name}" will be removed from the cluster. This cannot be undone.`}
        confirmLabel="Delete"
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
