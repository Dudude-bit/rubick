import { useMemo, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Boxes,
  ExternalLink,
  History,
  Info,
  RefreshCw,
  RotateCcw,
  ScrollText,
  SlidersHorizontal,
  StickyNote,
  Trash2,
} from "lucide-react";
import { dump } from "js-yaml";

import { fluxHelmReleasePath } from "@/integrations";
import { ConnectClusterEmptyState } from "@/components/ui/connect-cluster-empty-state";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DangerousConfirmDialog } from "@/components/ui/dangerous-confirm-dialog";
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
import { ResourceDetailLayout } from "@/components/resources/ResourceDetailLayout";
import {
  countMark,
  viewGlyph,
  type DetailTab,
} from "@/components/resources/detail-tab";
import { YamlTabContent } from "@/components/resources/YamlTabContent";
import { DetailAction } from "@/components/resources/detail-blocks";
import { ResourceRef } from "@/components/resources/ResourceRef";
import {
  KeyValueSection,
  type KeyValue,
} from "@/components/resources/detail-kv";
import { useCopyToClipboard } from "@/hooks";
import { commands } from "@/lib/commands";
import { normalizeTauriError } from "@/lib/error-utils";
import { statusRole } from "@/lib/status-role";
import { cn, formatDate } from "@/lib/utils";
import { useClusterStore } from "@/stores/clusterStore";
import { useDependenciesStore } from "@/stores/dependenciesStore";
import { installedObjects } from "@/lib/helm-manifest";
import { T } from "@/i18n/T";
import { useT } from "@/i18n/useT";

const INSTALLED_ROW =
  "grid grid-cols-[minmax(0,120px)_minmax(0,1fr)_minmax(0,150px)] items-baseline gap-2.5 border-b border-hair py-1 last:border-b-0 text-xs";

/**
 * Helm stores values as JSON; the tab shows them as YAML, because that is
 * the form you paste back into `helm upgrade -f`.
 *
 * This used to be `JSON.stringify` with the quotes taken out by two regexes,
 * which produced neither YAML nor JSON: braces and trailing commas survived,
 * and any empty or quote-bearing string lost one quote and kept the other —
 * `systemDefaultRegistry: "`. A serialiser is not optional here. `lineWidth`
 * is off because a wrapped value in a values file is a value nobody can copy
 * a line of.
 */
function valuesAsYaml(values: unknown, empty: string): string {
  if (typeof values === "string") return values;
  if (
    values == null ||
    (typeof values === "object" && Object.keys(values).length === 0)
  ) {
    return empty;
  }
  try {
    return dump(values, { indent: 2, lineWidth: -1, noRefs: true });
  } catch {
    return String(values);
  }
}

export function HelmDetail() {
  const t = useT();
  const { source, namespace, name } = useParams<{
    source: string;
    namespace: string;
    name: string;
  }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const copyToClipboard = useCopyToClipboard();
  const queryClient = useQueryClient();
  const { isConnected } = useClusterStore();
  const { helm } = useDependenciesStore();

  const [rollbackTarget, setRollbackTarget] = useState<number | null>(null);
  const [showUninstall, setShowUninstall] = useState(false);
  const [activeTab, setActiveTab] = useState("overview");

  const isNative = source === "native";
  const helmCliAvailable = helm?.available ?? false;
  const goBack = () => navigate("/helm");

  const {
    data: release,
    isLoading,
    isFetching,
    refetch,
    error,
  } = useQuery({
    queryKey: ["helm-release-detail", namespace, name],
    queryFn: async () => {
      if (!namespace || !name) throw new Error("Missing parameters");
      return await commands.getHelmReleaseDetail(name, namespace, null);
    },
    enabled: isConnected && !!namespace && !!name && isNative,
  });

  const { data: history = [], isLoading: historyLoading } = useQuery({
    queryKey: ["helm-history", name, namespace],
    queryFn: async () => {
      if (!namespace || !name) return [];
      return await commands.getHelmHistory(name, namespace);
    },
    enabled: isConnected && !!namespace && !!name && isNative,
  });

  const rollbackMutation = useMutation({
    mutationFn: async (revision: number) => {
      if (!namespace || !name) throw new Error("Missing parameters");
      return await commands.helmRollback(name, namespace, revision);
    },
    onSuccess: () => {
      toast({
        title: t("action", "rollbackInitiated"),
        description: t("action", "rollbackInitiatedDetail"),
      });
      queryClient.invalidateQueries({ queryKey: ["helm-release-detail"] });
      queryClient.invalidateQueries({ queryKey: ["helm-history"] });
      setRollbackTarget(null);
    },
    onError: (error) => {
      toast({
        title: t("action", "rollbackFailed"),
        description: normalizeTauriError(error),
        variant: "destructive",
      });
    },
  });

  const uninstallMutation = useMutation({
    mutationFn: async () => {
      if (!namespace || !name) throw new Error("Missing parameters");
      return await commands.helmUninstall(name, namespace);
    },
    onSuccess: () => {
      toast({
        title: t("action", "releaseUninstalled"),
        description: t("action", "releaseUninstalledDetail"),
      });
      navigate("/helm");
    },
    onError: (error) => {
      toast({
        title: t("action", "uninstallFailed"),
        description: normalizeTauriError(error),
        variant: "destructive",
      });
    },
  });

  const values = useMemo(
    () => valuesAsYaml(release?.values, t("empty", "noValuesSet")),
    [release?.values, t]
  );
  const manifest = release?.manifest || t("empty", "noStoredManifest");
  const installed = useMemo(
    () => installedObjects(release?.manifest ?? "", release?.namespace ?? ""),
    [release?.manifest, release?.namespace]
  );

  if (!isConnected) {
    return (
      <ConnectClusterEmptyState resourceLabel={t("empty", "helmReleases")} />
    );
  }

  // Flux owns its releases through a CRD; this page only speaks to Helm's
  // own storage, so it hands the object over rather than half-rendering it.
  if (!isNative) {
    return (
      <Section className="max-w-lg">
        <SectionHeader
          title={t("action", "managedByFlux")}
          count={`${namespace}/${name}`}
        />
        <p className="text-xs text-fg-mut">
          {t("empty", "fluxManagedRelease")}
        </p>
        <div className="flex items-center gap-1 pt-1">
          <DetailAction
            label={t("action", "backToReleases")}
            onClick={goBack}
          />
          <DetailAction
            label={t("action", "openHelmRelease")}
            icon={ExternalLink}
            onClick={() =>
              navigate(fluxHelmReleasePath(namespace ?? "", name ?? ""))
            }
          />
        </div>
      </Section>
    );
  }

  const failed = !!release && statusRole(release.status) === "err";
  const failedRevisions = history.filter(
    (rev) => statusRole(rev.status) === "err"
  ).length;

  const facts: KeyValue[] = [
    {
      label: t("columns", "chart"),
      value: `${release?.chart ?? "—"}:${release?.chartVersion ?? "—"}`,
      mono: true,
    },
    {
      label: t("columns", "appVersion"),
      value: release?.appVersion || "—",
      mono: true,
    },
    {
      label: t("columns", "revision"),
      value: release?.revision ?? "—",
      mono: true,
    },
    {
      label: t("columns", "lastDeployed"),
      value: formatDate(release?.lastDeployed) ?? "—",
    },
    {
      label: t("columns", "firstDeployed"),
      value: formatDate(release?.firstDeployed) ?? "—",
    },
    ...(release?.description
      ? [
          {
            label: t("columns", "description"),
            value: release.description,
            tone: failed ? ("err" as const) : undefined,
          },
        ]
      : []),
  ];

  const tabs: DetailTab[] = [
    {
      id: "overview",
      label: t("nav", "overview"),
      glyph: viewGlyph(Info),
      content: (
        <>
          <KeyValueSection
            title={t("action", "releaseHeading")}
            items={facts}
            className="max-w-lg"
          />
          {!helmCliAvailable && (
            <p className="text-[11px] text-warn">
              {t("empty", "helmCliMissing")}
            </p>
          )}
        </>
      ),
    },
    {
      id: "history",
      label: t("action", "history"),
      glyph: viewGlyph(History),
      mark: countMark(history.length),
      content: (
        <Section>
          <SectionHeader
            title={t("action", "revisionsHeading")}
            count={
              failedRevisions > 0
                ? t("count", "withFailed", {
                    total: history.length,
                    n: failedRevisions,
                  })
                : history.length || undefined
            }
          />
          {historyLoading ? (
            <p className="text-xs text-fg-fnt">
              {t("empty", "readingHistory")}
            </p>
          ) : history.length === 0 ? (
            <p className="text-xs text-fg-fnt">
              <T section="empty" k="noHelmHistory" />
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("columns", "rev")}</TableHead>
                  <TableHead>{t("columns", "status")}</TableHead>
                  <TableHead>{t("columns", "chart")}</TableHead>
                  <TableHead>{t("columns", "app")}</TableHead>
                  <TableHead>{t("columns", "updated")}</TableHead>
                  <TableHead>{t("columns", "description")}</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {history.map((rev) => {
                  const current = rev.revision === release?.revision;
                  return (
                    <TableRow
                      key={rev.revision}
                      className={cn(current && "bg-sel")}
                      data-quiet={current || undefined}
                    >
                      <TableCell className="font-mono text-fg">
                        {rev.revision}
                        {current && (
                          <span className="ml-1.5 text-[11px] text-fg-fnt">
                            current
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={rev.status} />
                      </TableCell>
                      <TableCell className="font-mono text-fg-mut">
                        {rev.chart}
                      </TableCell>
                      <TableCell className="font-mono text-fg-fnt">
                        {rev.appVersion || "—"}
                      </TableCell>
                      <TableCell className="text-fg-fnt">
                        {formatDate(rev.updated) ?? "—"}
                      </TableCell>
                      <TableCell className="max-w-[240px] truncate text-fg-fnt">
                        {rev.description || "—"}
                      </TableCell>
                      <TableCell>
                        <span className="flex justify-end">
                          {!current && helmCliAvailable && (
                            <DetailAction
                              label={t("action", "rollBack")}
                              icon={RotateCcw}
                              onClick={() => setRollbackTarget(rev.revision)}
                            />
                          )}
                        </span>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </Section>
      ),
    },
    {
      id: "resources",
      label: t("action", "paletteResources"),
      glyph: viewGlyph(Boxes),
      mark: countMark(installed.length),
      content: (
        <Section>
          <SectionHeader
            title={t("action", "installedByRelease")}
            count={installed.length || undefined}
          />
          {installed.length === 0 ? (
            <p className="text-xs text-fg-fnt">
              {t("empty", "manifestDeclaresNoObjects")}
            </p>
          ) : (
            <div>
              {installed.map((object) => (
                <div
                  key={`${object.kind}/${object.namespace}/${object.name}`}
                  className={INSTALLED_ROW}
                >
                  <span className="truncate text-fg-mut">{object.kind}</span>
                  <span className="min-w-0 truncate">
                    {/* The kind is its own column; repeating it in the
                        reference would print it twice on every row. */}
                    <ResourceRef
                      kind={object.kind}
                      name={object.name}
                      namespace={object.namespace}
                      showKind={false}
                    />
                  </span>
                  {/* Only where the chart put the object somewhere else. The
                      header already says which namespace the release is in,
                      and printing it on every row also claimed a namespace
                      for the cluster-scoped kinds, which have none. */}
                  <span className="truncate text-[11px] text-fg-fnt">
                    {object.namespace === release?.namespace
                      ? ""
                      : object.namespace}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Section>
      ),
    },
    {
      id: "values",
      label: t("action", "valuesTab"),
      glyph: viewGlyph(SlidersHorizontal),
      kind: "surface",
      content: (
        <YamlTabContent
          title={t("action", "valuesOf", { name: release?.name ?? name ?? "" })}
          yaml={values}
          note={t("action", "valuesNote")}
          onCopy={() =>
            copyToClipboard(values, t("action", "releaseValuesCopied"))
          }
        />
      ),
    },
    {
      id: "manifest",
      label: t("action", "manifestTab"),
      glyph: viewGlyph(ScrollText),
      kind: "surface",
      content: (
        <YamlTabContent
          title={t("action", "manifestOf", {
            name: release?.name ?? name ?? "",
          })}
          yaml={manifest}
          note={t("action", "manifestNote")}
          onCopy={() =>
            copyToClipboard(manifest, t("action", "renderedManifestCopied"))
          }
        />
      ),
    },
    ...(release?.notes
      ? [
          {
            id: "notes",
            label: t("action", "notesHeading"),
            glyph: viewGlyph(StickyNote),
            // Not a surface: NOTES.txt is usually four lines, and a pane
            // stretched to the window would be one sentence over a page of
            // canvas.
            content: (
              <Section>
                <SectionHeader title={t("action", "notesHeading")} />
                <pre className="max-h-[560px] overflow-auto whitespace-pre-wrap border-t border-hair pt-2 font-mono text-xs text-fg-mid">
                  {release.notes}
                </pre>
              </Section>
            ),
          },
        ]
      : []),
  ];

  return (
    <>
      <ResourceDetailLayout
        resource={release}
        isLoading={isLoading}
        error={error}
        resourceKind={t("readings", "helmRelease")}
        listUrl="/helm"
        listLabel="Helm"
        // The Helm list filters by a namespace of its own that this scope does
        // not drive, so sending the reader there would narrow the tab and show
        // them every namespace anyway. The scope alone is the honest half.
        namespaceUrl={null}
        title={release?.name || name || ""}
        namespace={release?.namespace || namespace}
        createdAt={release?.firstDeployed}
        statusBadge={release && <StatusBadge status={release.status} />}
        badges={
          release && (
            <>
              <span className="font-mono text-[11px] text-fg-mut">
                {release.chart}:{release.chartVersion}
              </span>
              <span className="text-[11px] text-fg-fnt">
                {t("columns", "revisionInline", { n: release.revision })}
              </span>
            </>
          )
        }
        onBack={goBack}
        actions={
          <>
            <DetailAction
              label={t("action", "refresh")}
              icon={RefreshCw}
              onClick={() => refetch()}
              busy={isFetching}
            />
            {helmCliAvailable && release && (
              <>
                <DetailAction
                  label={t("action", "rollBack")}
                  icon={RotateCcw}
                  onClick={() => setRollbackTarget(release.revision - 1)}
                  disabled={release.revision <= 1}
                />
                <DetailAction
                  label={t("action", "uninstall")}
                  icon={Trash2}
                  onClick={() => setShowUninstall(true)}
                  danger
                />
              </>
            )}
          </>
        }
        tabs={tabs}
        activeTab={activeTab}
        onTabChange={setActiveTab}
      />

      <ConfirmDialog
        open={rollbackTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRollbackTarget(null);
        }}
        title={t("action", "rollBackReleaseQuestion")}
        description={t("action", "rollBackReleaseDetail", {
          name: release?.name ?? "",
          revision: rollbackTarget ?? 0,
        })}
        confirmLabel={t("action", "rollBack")}
        confirmVariant="default"
        confirmDisabled={rollbackMutation.isPending}
        onConfirm={() => {
          if (rollbackTarget !== null) {
            rollbackMutation.mutate(rollbackTarget);
          }
        }}
      />

      <DangerousConfirmDialog
        open={showUninstall}
        onOpenChange={setShowUninstall}
        title={t("action", "uninstallRelease")}
        description={t("action", "uninstallReleaseDetail", {
          name: release?.name ?? "",
          namespace: release?.namespace ?? "",
        })}
        confirmationText={release?.name ?? ""}
        confirmLabel={t("action", "uninstall")}
        isLoading={uninstallMutation.isPending}
        onConfirm={() => uninstallMutation.mutate()}
      />
    </>
  );
}

export default HelmDetail;
