import { useCallback, useState } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { BadgeCheck, GitBranch, Info, ListTree, Tag } from "lucide-react";

import type { ShareContribution } from "@/components/share/contribution";
import {
  crdConditionsSection,
  crdFactsSection,
  crdVersionsSection,
} from "@/lib/share/crd-share";
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
import { yamlTab } from "../../../-object/yaml-tab";
import { SchemaViewer } from "./SchemaViewer";
import { CustomResourceList } from "./CustomResourceList";
import { ResourceDetailLayout } from "../../../-object/ResourceDetailLayout";
import {
  conditionsMark,
  countMark,
  kindGlyph,
  viewGlyph,
  type DetailTab,
} from "@/components/object/detail-tab";
import { ConditionRows } from "@/components/object/detail-blocks";
import { KindIcon } from "@/components/object/KindIcon";
import { KeyValueSection, type KeyValue } from "../../../-object/detail-kv";
import { recordToKeyValues } from "@/components/object/key-values";
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";
import { commands } from "@/lib/commands";
import { queryKeys } from "@/lib/query-keys";
import { deliveryOfKind } from "@/lib/delivery";
import { DeleteAction } from "../../../-object/DeleteAction";
import { useDeliveryIntercept } from "../../../-delivery/useDelivery";
import { normalizeTauriError } from "@/lib/error-utils";
import { ResourceType } from "@/lib/resource-registry";
import { listLink } from "@/lib/links";
import { useAppSearch, useSetSearch } from "@/hooks/useSearchParam";
import { cn } from "@/lib/utils";
import { useT } from "@/i18n/useT";
import { scopeKey } from "./crd-scope";
import { toastError } from "@/lib/toast-error";
import { None } from "@/components/ui/none";
import { eventsTab } from "../../../-object/events-tab";
import { useObjectEvents } from "@/hooks/useObjectEvents";

export function CrdDetail() {
  const t = useT();
  const { name } = useParams({ strict: false });
  const events = useObjectEvents(
    ResourceType.CustomResourceDefinition,
    name,
    null,
    {
      refresh: "slow",
    }
  );
  const navigate = useNavigate();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const copyToClipboard = useCopyToClipboard();
  const search = useAppSearch();
  const setSearch = useSetSearch();
  // Only the initial value. A link that says "show me the objects" has to
  // land on them, and a reader who then clicks another tab has changed
  // their mind — re-reading the URL after that would take it back.
  const [activeTab, setActiveTab] = useState(() => search.tab ?? "overview");
  const changeTab = (tab: string) => {
    setActiveTab(tab);
    setSearch({ tab: tab === "overview" ? undefined : tab }, { replace: true });
  };
  const [selectedVersion, setSelectedVersion] = useState<string | null>(null);

  const goBack = () =>
    navigate(listLink(ResourceType.CustomResourceDefinition));

  const {
    data: crd,
    isLoading,
    error,
  } = useQuery({
    queryKey: queryKeys.crd(name),
    queryFn: async () => {
      if (!name) throw new Error("CRD name is required");
      try {
        return await commands.getCrd(name);
      } catch (err) {
        throw new Error(normalizeTauriError(err), { cause: err });
      }
    },
    enabled: !!name,
  });

  const { data: yaml } = useQuery({
    queryKey: ["crd-yaml", name],
    queryFn: async () => {
      if (!name) throw new Error("CRD name is required");
      try {
        return await commands.getCrdYaml(name);
      } catch (err) {
        throw new Error(normalizeTauriError(err), { cause: err });
      }
    },
    enabled: !!name && activeTab === "yaml",
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      if (!name) return;
      try {
        await commands.deleteCrd(name);
      } catch (err) {
        throw new Error(normalizeTauriError(err), { cause: err });
      }
    },
    onSuccess: () => {
      toast({
        title: t("action", "kindDeleted", { kind: "CRD" }),
        description: t("action", "kindDeletedDetail", {
          kind: "CRD",
          name: name ?? "",
        }),
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.crds() });
      goBack();
    },
    onError: (err: Error) => {
      toastError(t("action", "deleteKindFailed", { kind: "CRD" }), err);
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
    { label: t("columns", "group"), value: crd?.group || "core", mono: true },
    { label: t("columns", "kind"), value: crd?.kind ?? <None />, mono: true },
    {
      label: t("columns", "scope"),
      value: crd && t("apiResources", scopeKey(crd.scope)),
    },
    {
      label: t("columns", "storageVersion"),
      value: storageVersion?.name ?? t("empty", "noneDeclared"),
      mono: !!storageVersion,
      tone: storageVersion ? undefined : "warn",
    },
    {
      label: t("columns", "plural"),
      value: crd?.plural ?? <None />,
      mono: true,
    },
    {
      label: t("columns", "singular"),
      value: crd?.singular || <None />,
      mono: true,
    },
    {
      label: t("columns", "shortNames"),
      value: crd?.shortNames.length
        ? crd.shortNames.join(" · ")
        : t("empty", "noneInline"),
      mono: !!crd?.shortNames.length,
    },
    {
      label: t("columns", "categories"),
      value: crd?.categories.length
        ? crd.categories.join(" · ")
        : t("empty", "noneInline"),
      mono: !!crd?.categories.length,
    },
  ];

  const deliveryQuery = deliveryOfKind(
    ResourceType.CustomResourceDefinition,
    crd
  );
  const intercept = useDeliveryIntercept(deliveryQuery);

  const share = useCallback((): ShareContribution => {
    if (!crd) return {};
    return {
      sections: [crdFactsSection(crd, t), crdVersionsSection(crd, t)],
      conditions: crdConditionsSection(crd.conditions, t),
    };
  }, [crd, t]);

  const tabs: DetailTab[] = [
    {
      id: "overview",
      label: t("nav", "overview"),
      glyph: viewGlyph(Info),
      content: (
        <KeyValueSection
          title={t("nav", "definition")}
          items={facts}
          className="max-w-lg"
        />
      ),
    },
    {
      id: "versions",
      label: t("nav", "versions"),
      glyph: viewGlyph(GitBranch),
      mark: countMark(crd?.versions.length ?? 0),
      content: (
        <Section>
          <SectionHeader
            title={t("nav", "versions")}
            count={
              deprecatedVersions.length > 0
                ? t("count", "versionsWithDeprecated", {
                    n: crd?.versions.length ?? 0,
                    deprecated: deprecatedVersions.length,
                  })
                : (crd?.versions.length ?? 0)
            }
          />
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("columns", "version")}</TableHead>
                <TableHead>{t("columns", "served")}</TableHead>
                <TableHead>{t("columns", "storage")}</TableHead>
                <TableHead>{t("columns", "printerColumns")}</TableHead>
                <TableHead>{t("columns", "note")}</TableHead>
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
                    {version.served ? t("action", "yes") : t("action", "no")}
                  </TableCell>
                  <TableCell className="text-fg-mut">
                    {version.storage ? t("action", "yes") : t("action", "no")}
                  </TableCell>
                  <TableCell className="text-fg-fnt">
                    {version.additionalPrinterColumns.length || "default"}
                  </TableCell>
                  <TableCell
                    className={version.deprecated ? "text-warn" : "text-fg-fnt"}
                  >
                    {version.deprecated
                      ? version.deprecationWarning ||
                        t("empty", "deprecatedInline")
                      : t("action", "no")}
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
      label: t("nav", "schema"),
      glyph: viewGlyph(ListTree),
      content: (
        <Section>
          <SectionHeader
            title={t("nav", "openApiSchema")}
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
                {t("empty", "noStructuralSchema")}
              </p>
            )}
          </div>
        </Section>
      ),
    },
    {
      id: "instances",
      label: t("nav", "instances"),
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
      label: t("nav", "conditions"),
      glyph: viewGlyph(BadgeCheck),
      mark: conditionsMark(conditions, t),
      content: (
        <Section>
          <SectionHeader
            title={t("nav", "conditions")}
            count={
              conditions.length > 0
                ? t("count", "conditions", { n: conditions.length })
                : undefined
            }
          />
          <ConditionRows conditions={conditions} />
        </Section>
      ),
    },
    {
      id: "metadata",
      label: t("nav", "metadata"),
      glyph: viewGlyph(Tag),
      content: (
        <>
          <KeyValueSection
            title={t("columns", "labels")}
            count={Object.keys(crd?.labels ?? {}).length}
            items={recordToKeyValues(crd?.labels ?? {})}
            emptyMessage={t("empty", "noLabels")}
          />
          <KeyValueSection
            title={t("columns", "annotations")}
            count={Object.keys(crd?.annotations ?? {}).length}
            items={recordToKeyValues(crd?.annotations ?? {})}
            emptyMessage={t("empty", "noAnnotations")}
          />
        </>
      ),
    },
    eventsTab(events, t, {
      kind: ResourceType.CustomResourceDefinition,
      name: name ?? "",
    }),
    yamlTab({
      title: t("action", "kindYaml", { kind: "CustomResourceDefinition" }),
      yaml,
      onCopy: () => yaml && copyToClipboard(yaml),
      resourceKind: ResourceType.CustomResourceDefinition,
      resourceName: name,
    }),
  ];

  return (
    <>
      <ResourceDetailLayout
        resource={crd}
        share={share}
        delivery={deliveryQuery}
        isLoading={isLoading}
        error={error}
        resourceKind={ResourceType.CustomResourceDefinition}
        title={crd?.name || name || ""}
        createdAt={crd?.createdAt}
        statusBadge={
          crd && (
            <StatusBadge
              status={
                notEstablished
                  ? t("readings", "crdNotEstablished")
                  : t("readings", "crdEstablished")
              }
              roleOverride={notEstablished ? "err" : "ok"}
            />
          )
        }
        badges={
          crd && (
            <>
              <span className="flex min-w-0 items-center gap-1 text-[11px] text-fg-mut">
                <KindIcon kind={crd.kind} className="h-3 w-3" />
                <span className="truncate">{crd.kind}</span>
              </span>
              <span className="text-[11px] text-fg-fnt">
                {t("apiResources", scopeKey(crd.scope))}
              </span>
            </>
          )
        }
        onBack={goBack}
        actions={
          <DeleteAction
            kind={ResourceType.CustomResourceDefinition}
            name={name ?? ""}
            intercept={intercept("Delete")}
            mutation={name ? deleteMutation : null}
          />
        }
        tabs={tabs}
        activeTab={activeTab}
        onTabChange={changeTab}
      />
    </>
  );
}
