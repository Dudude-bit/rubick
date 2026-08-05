import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, RefreshCw, RotateCcw, Trash2 } from "lucide-react";

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
import { YamlEditor } from "@/components/yaml/YamlEditor";
import { ResourceDetailLayout } from "@/components/resources/ResourceDetailLayout";
import { DetailAction } from "@/components/resources/detail-blocks";
import {
  KeyValueSection,
  type KeyValue,
} from "@/components/resources/detail-kv";
import { commands } from "@/lib/commands";
import { normalizeTauriError } from "@/lib/error-utils";
import { statusRole } from "@/lib/status-role";
import { cn, formatDate } from "@/lib/utils";
import { useClusterStore } from "@/stores/clusterStore";
import { useDependenciesStore } from "@/stores/dependenciesStore";

/**
 * Helm stores values as JSON. Rendering them through the YAML editor keeps
 * one code viewer on screen instead of two, so the braces are stripped down
 * to indented `key: value` rather than shown as JSON.
 */
function valuesAsYaml(values: unknown): string {
  if (!values) return "# No values set — the chart's defaults apply.";
  if (typeof values === "string") return values;
  try {
    return JSON.stringify(values, null, 2)
      .replace(/"([^"]+)":/g, "$1:")
      .replace(/"([^"]+)"/g, "$1");
  } catch {
    return String(values);
  }
}

export function HelmDetail() {
  const { source, namespace, name } = useParams<{
    source: string;
    namespace: string;
    name: string;
  }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { isConnected } = useClusterStore();
  const { helm } = useDependenciesStore();

  const [rollbackTarget, setRollbackTarget] = useState<number | null>(null);
  const [showUninstall, setShowUninstall] = useState(false);
  const [activeTab, setActiveTab] = useState("history");

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
        title: "Rollback initiated",
        description: "The release is being rolled back.",
      });
      queryClient.invalidateQueries({ queryKey: ["helm-release-detail"] });
      queryClient.invalidateQueries({ queryKey: ["helm-history"] });
      setRollbackTarget(null);
    },
    onError: (error) => {
      toast({
        title: "Rollback failed",
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
        title: "Release uninstalled",
        description: "The Helm release has been successfully uninstalled.",
      });
      navigate("/helm");
    },
    onError: (error) => {
      toast({
        title: "Uninstall failed",
        description: normalizeTauriError(error),
        variant: "destructive",
      });
    },
  });

  if (!isConnected) {
    return (
      <p className="text-xs text-fg-mut">
        Connect to a cluster to read Helm releases.
      </p>
    );
  }

  // Flux owns its releases through a CRD; this page only speaks to Helm's
  // own storage, so it hands the object over rather than half-rendering it.
  if (!isNative) {
    return (
      <Section className="max-w-lg">
        <SectionHeader title="Managed by Flux" count={`${namespace}/${name}`} />
        <p className="text-xs text-fg-mut">
          This release is a Flux CD HelmRelease. Its spec, status and
          reconciliation history live on the custom resource.
        </p>
        <div className="flex items-center gap-1 pt-1">
          <DetailAction label="Back to releases" onClick={goBack} />
          <DetailAction
            label="Open the HelmRelease"
            icon={ExternalLink}
            onClick={() =>
              navigate(
                `/crds/helm.toolkit.fluxcd.io/helmreleases/${namespace}/${name}`
              )
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
      label: "Chart",
      value: `${release?.chart ?? "—"}:${release?.chartVersion ?? "—"}`,
      mono: true,
    },
    { label: "App version", value: release?.appVersion || "—", mono: true },
    { label: "Revision", value: release?.revision ?? "—", mono: true },
    {
      label: "Last deployed",
      value: formatDate(release?.lastDeployed) ?? "—",
    },
    {
      label: "First deployed",
      value: formatDate(release?.firstDeployed) ?? "—",
    },
    ...(release?.description
      ? [
          {
            label: "Description",
            value: release.description,
            tone: failed ? ("err" as const) : undefined,
          },
        ]
      : []),
  ];

  const tabs = [
    {
      id: "history",
      label: "History",
      content: (
        <Section>
          <SectionHeader
            title="Revisions"
            count={
              failedRevisions > 0
                ? `${history.length} · ${failedRevisions} failed`
                : history.length || undefined
            }
          />
          {historyLoading ? (
            <p className="text-xs text-fg-fnt">Reading history…</p>
          ) : history.length === 0 ? (
            <p className="text-xs text-fg-fnt">
              No history — Helm keeps none for this release.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Rev</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Chart</TableHead>
                  <TableHead>App</TableHead>
                  <TableHead>Updated</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {history.map((rev) => {
                  const current = rev.revision === release?.revision;
                  const revFailed = statusRole(rev.status) === "err";
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
                        <span
                          className={cn(
                            "text-[11px]",
                            revFailed ? "text-err" : "text-fg-mut"
                          )}
                        >
                          {rev.status}
                        </span>
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
                              label="Roll back"
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
      id: "values",
      label: "Values",
      content: (
        <Section>
          <SectionHeader
            title="Values"
            count="what this release overrides in the chart"
          />
          <div className="overflow-hidden border-t border-hair">
            <YamlEditor
              value={valuesAsYaml(release?.values)}
              readOnly
              height="560px"
            />
          </div>
        </Section>
      ),
    },
    {
      id: "manifest",
      label: "Manifest",
      content: (
        <Section>
          <SectionHeader
            title="Rendered manifest"
            count="what the chart actually applied"
          />
          <div className="overflow-hidden border-t border-hair">
            <YamlEditor
              value={release?.manifest || "# No manifest available"}
              readOnly
              height="560px"
            />
          </div>
        </Section>
      ),
    },
    ...(release?.notes
      ? [
          {
            id: "notes",
            label: "Notes",
            content: (
              <Section>
                <SectionHeader title="Notes" />
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
        resourceKind="Helm release"
        listUrl="/helm"
        listLabel="Helm"
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
                rev {release.revision}
              </span>
            </>
          )
        }
        onBack={goBack}
        actions={
          <>
            <DetailAction
              label="Refresh"
              icon={RefreshCw}
              onClick={() => refetch()}
              busy={isFetching}
            />
            {helmCliAvailable && release && (
              <>
                <DetailAction
                  label="Roll back"
                  icon={RotateCcw}
                  onClick={() => setRollbackTarget(release.revision - 1)}
                  disabled={release.revision <= 1}
                />
                <DetailAction
                  label="Uninstall"
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
      >
        <KeyValueSection title="Release" items={facts} className="max-w-lg" />
        {!helmCliAvailable && (
          <p className="text-[11px] text-warn">
            Helm CLI not found — rollback and uninstall are unavailable.
          </p>
        )}
      </ResourceDetailLayout>

      <ConfirmDialog
        open={rollbackTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRollbackTarget(null);
        }}
        title="Roll back release?"
        description={`"${release?.name}" will be rolled back to revision ${rollbackTarget}.`}
        confirmLabel="Roll back"
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
        title="Uninstall release"
        description={`This permanently deletes the Helm release "${release?.name}" and every resource it created in namespace "${release?.namespace}". This cannot be undone.`}
        confirmationText={release?.name ?? ""}
        confirmLabel="Uninstall"
        isLoading={uninstallMutation.isPending}
        onConfirm={() => uninstallMutation.mutate()}
      />
    </>
  );
}

export default HelmDetail;
