import { useState } from "react";
import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  BadgeCheck,
  GitBranch,
  Info,
  ListTree,
  Tag,
  Trash2,
} from "lucide-react";

import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Section, SectionHeader } from "@/components/ui/section";
import { StatusBadge } from "@/components/ui/status-badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/components/ui/use-toast";
import { yamlTab } from "@/components/resources/yaml-tab";
import { SchemaViewer } from "@/components/crds/SchemaViewer";
import { CustomResourceList } from "@/components/resources/CustomResourceList";
import { ResourceDetailLayout } from "@/components/resources/ResourceDetailLayout";
import {
  conditionsMark,
  countMark,
  kindGlyph,
  viewGlyph,
  type DetailTab,
} from "@/components/resources/detail-tab";
import { ConditionRows } from "@/components/resources/detail-blocks";
import {
  KeyValueSection,
  type KeyValue,
} from "@/components/resources/detail-kv";
import { recordToKeyValues } from "@/components/resources/key-values";
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";
import { commands } from "@/lib/commands";
import { deliveryOfKind } from "@/lib/delivery";
import { InterceptedAction } from "@/components/resources/delivery-intercept";
import { useDeliveryIntercept } from "@/hooks/useDelivery";
import { normalizeTauriError } from "@/lib/error-utils";
import { ResourceType, toPlural } from "@/lib/resource-registry";
import { cn } from "@/lib/utils";
import { useT } from "@/i18n/useT";

export function CrdDetail() {
  const t = useT();
  const { name } = useParams<{ name: string }>();
  const decodedName = name ? decodeURIComponent(name) : undefined;
  const navigate = useNavigate();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const copyToClipboard = useCopyToClipboard();
  const [searchParams] = useSearchParams();
  // Only the initial value. A link that says "show me the objects" has to
  // land on them, and a reader who then clicks another tab has changed
  // their mind — re-reading the URL after that would take it back.
  const [activeTab, setActiveTab] = useState(
    () => searchParams.get("tab") ?? "overview"
  );
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [selectedVersion, setSelectedVersion] = useState<string | null>(null);

  const goBack = () =>
    navigate(`/${toPlural(ResourceType.CustomResourceDefinition)}`);

  const {
    data: crd,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["crd", decodedName],
    queryFn: async () => {
      if (!decodedName) throw new Error("CRD name is required");
      try {
        return await commands.getCrd(decodedName);
      } catch (err) {
        throw new Error(normalizeTauriError(err), { cause: err });
      }
    },
    enabled: !!decodedName,
  });

  const { data: yaml } = useQuery({
    queryKey: ["crd-yaml", decodedName],
    queryFn: async () => {
      if (!decodedName) throw new Error("CRD name is required");
      try {
        return await commands.getCrdYaml(decodedName);
      } catch (err) {
        throw new Error(normalizeTauriError(err), { cause: err });
      }
    },
    enabled: !!decodedName && activeTab === "yaml",
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      if (!decodedName) return;
      try {
        await commands.deleteCrd(decodedName);
      } catch (err) {
        throw new Error(normalizeTauriError(err), { cause: err });
      }
    },
    onSuccess: () => {
      toast({
        title: "CRD deleted",
        description: `${decodedName} has been deleted.`,
      });
      queryClient.invalidateQueries({ queryKey: ["crds"] });
      navigate(`/${toPlural(ResourceType.CustomResourceDefinition)}`);
    },
    onError: (err: Error) => {
      toast({
        title: "Failed to delete CRD",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const storageVersion = crd?.versions.find((v) => v.storage);
  const activeVersionName = selectedVersion ?? storageVersion?.name ?? null;
  const currentVersion =
    crd?.versions.find((v) => v.name === activeVersionName) ?? storageVersion;

  const conditions = (crd?.conditions ?? []).map((c) => ({
    type: c.conditionType,
    status: c.status,
    reason: c.reason,
    message: c.message,
    lastTransitionTime: c.lastTransitionTime,
  }));
  // Until the API server establishes the definition, none of these versions
  // serve anything — which is why "kubectl get" returns nothing at all.
  const established = conditions.find((c) => c.type === "Established");
  const notEstablished = !!crd && established?.status !== "True";

  const deprecatedVersions = (crd?.versions ?? []).filter((v) => v.deprecated);

  const facts: KeyValue[] = [
    { label: "Group", value: crd?.group || "core", mono: true },
    { label: "Kind", value: crd?.kind ?? "—", mono: true },
    { label: "Scope", value: crd?.scope ?? "—" },
    {
      label: "Storage version",
      value: storageVersion?.name ?? "none declared",
      mono: !!storageVersion,
      tone: storageVersion ? undefined : "warn",
    },
    { label: "Plural", value: crd?.plural ?? "—", mono: true },
    { label: "Singular", value: crd?.singular || "—", mono: true },
    {
      label: "Short names",
      value: crd?.shortNames.length ? crd.shortNames.join(" · ") : "none",
      mono: !!crd?.shortNames.length,
    },
    {
      label: "Categories",
      value: crd?.categories.length ? crd.categories.join(" · ") : "none",
      mono: !!crd?.categories.length,
    },
  ];

  const deliveryQuery = deliveryOfKind(
    ResourceType.CustomResourceDefinition,
    crd
  );
  const intercept = useDeliveryIntercept(deliveryQuery);

  const tabs: DetailTab[] = [
    {
      id: "overview",
      label: "Overview",
      glyph: viewGlyph(Info),
      content: (
        <KeyValueSection
          title="Definition"
          items={facts}
          className="max-w-lg"
        />
      ),
    },
    {
      id: "versions",
      label: "Versions",
      glyph: viewGlyph(GitBranch),
      mark: countMark(crd?.versions.length ?? 0),
      content: (
        <Section>
          <SectionHeader
            title="Versions"
            count={
              deprecatedVersions.length > 0
                ? `${crd?.versions.length ?? 0} · ${deprecatedVersions.length} deprecated`
                : (crd?.versions.length ?? 0)
            }
          />
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Version</TableHead>
                <TableHead>Served</TableHead>
                <TableHead>Storage</TableHead>
                <TableHead>Printer columns</TableHead>
                <TableHead>Note</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(crd?.versions ?? []).map((version) => (
                <TableRow key={version.name} data-quiet>
                  <TableCell className="font-mono text-fg">
                    {version.name}
                  </TableCell>
                  <TableCell
                    className={version.served ? "text-fg-mut" : "text-warn"}
                  >
                    {version.served ? "yes" : "no"}
                  </TableCell>
                  <TableCell className="text-fg-mut">
                    {version.storage ? "yes" : "no"}
                  </TableCell>
                  <TableCell className="text-fg-fnt">
                    {version.additionalPrinterColumns.length || "default"}
                  </TableCell>
                  <TableCell
                    className={version.deprecated ? "text-warn" : "text-fg-fnt"}
                  >
                    {version.deprecated
                      ? version.deprecationWarning || "deprecated"
                      : "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Section>
      ),
    },
    {
      id: "schema",
      label: "Schema",
      glyph: viewGlyph(ListTree),
      content: (
        <Section>
          <SectionHeader
            title="OpenAPI schema"
            count={activeVersionName ?? undefined}
            actions={
              crd &&
              crd.versions.length > 1 && (
                <div className="flex items-center gap-0.5">
                  {crd.versions.map((v) => (
                    <button
                      key={v.name}
                      type="button"
                      onClick={() => setSelectedVersion(v.name)}
                      aria-pressed={activeVersionName === v.name}
                      className={cn(
                        "h-6 rounded px-1.5 font-mono text-[11px] transition-colors hover:bg-hover",
                        activeVersionName === v.name
                          ? "bg-sel text-fg"
                          : "text-fg-mut hover:text-fg"
                      )}
                    >
                      {v.name}
                    </button>
                  ))}
                </div>
              )
            }
          />
          <div className="border-t border-hair pt-1">
            {currentVersion?.schema ? (
              <SchemaViewer schema={currentVersion.schema} />
            ) : (
              <p className="py-1 text-xs text-fg-fnt">
                This version publishes no structural schema, so the API server
                validates nothing beyond the object's metadata.
              </p>
            )}
          </div>
        </Section>
      ),
    },
    {
      id: "instances",
      label: "Instances",
      // The CRD's own kind, so the tab carries whatever mark the list of
      // these objects carries everywhere else — a dashed circle and the
      // neutral hue for a kind the registry has never heard of.
      glyph: kindGlyph(crd?.kind ?? ""),
      content: crd && (
        <CustomResourceList
          crdName={crd.name}
          crdKind={crd.kind}
          crdGroup={crd.group}
          crdVersion={storageVersion?.name ?? crd.versions[0]?.name ?? "v1"}
          crdPlural={crd.plural}
          scope={crd.scope as "Namespaced" | "Cluster"}
          printerColumns={storageVersion?.additionalPrinterColumns}
          embedded
        />
      ),
    },
    {
      id: "conditions",
      label: "Conditions",
      glyph: viewGlyph(BadgeCheck),
      mark: conditionsMark(conditions),
      content: (
        <Section>
          <SectionHeader title="Conditions" count={conditions.length} />
          <ConditionRows conditions={conditions} />
        </Section>
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
            count={Object.keys(crd?.labels ?? {}).length}
            items={recordToKeyValues(crd?.labels ?? {})}
            emptyMessage={t("empty", "noLabels")}
          />
          <KeyValueSection
            title="Annotations"
            count={Object.keys(crd?.annotations ?? {}).length}
            items={recordToKeyValues(crd?.annotations ?? {})}
            emptyMessage={t("empty", "noAnnotations")}
          />
        </>
      ),
    },
    yamlTab({
      title: "CustomResourceDefinition YAML",
      yaml,
      onCopy: () => yaml && copyToClipboard(yaml),
      resourceKind: ResourceType.CustomResourceDefinition,
      resourceName: decodedName,
    }),
  ];

  return (
    <>
      <ResourceDetailLayout
        resource={crd}
        delivery={deliveryQuery}
        isLoading={isLoading}
        error={error}
        resourceKind={ResourceType.CustomResourceDefinition}
        title={crd?.kind || decodedName || ""}
        createdAt={crd?.createdAt}
        statusBadge={
          crd && (
            <StatusBadge
              status={notEstablished ? "Not established" : "Established"}
              roleOverride={notEstablished ? "err" : "ok"}
            />
          )
        }
        badges={
          crd && (
            <>
              <span className="truncate font-mono text-[11px] text-fg-mut">
                {crd.name}
              </span>
              <span className="text-[11px] text-fg-fnt">{crd.scope}</span>
            </>
          )
        }
        onBack={goBack}
        actions={
          <InterceptedAction
            intercept={intercept("Delete")}
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
      />

      <ConfirmDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        title="Delete CRD?"
        description={`Deleting "${decodedName}" also deletes every instance of this custom resource in the cluster.`}
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
