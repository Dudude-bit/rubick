import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLiveQuery } from "@/hooks/useLiveQuery";

import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ConnectClusterEmptyState } from "@/components/ui/connect-cluster-empty-state";
import { DangerousConfirmDialog } from "@/components/ui/dangerous-confirm-dialog";
import { SectionHeader } from "@/components/ui/section";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/components/ui/use-toast";
import {
  HelmStatusBanner,
  HelmInstallDialog,
  HelmUpgradeDialog,
  HelmAddRepoDialog,
  HelmHistoryDialog,
  HelmReleasesTab,
  HelmChartsTab,
  HelmRepositoriesTab,
} from "@/components/helm";
import { Package, Search, FolderGit2 } from "lucide-react";
import { commands } from "@/lib/commands";
import type {
  HelmRelease,
  HelmChartSearchResult,
  HelmInstallOptions,
} from "@/generated/types";
import { normalizeTauriError } from "@/lib/error-utils";
import { useClusterStore } from "@/stores/clusterStore";
import { useDependenciesStore } from "@/stores/dependenciesStore";
import { useT } from "@/i18n/useT";

export function Helm() {
  const t = useT();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { isConnected } = useClusterStore();
  const { helm, checkHelmAvailability } = useDependenciesStore();

  const [rollbackTarget, setRollbackTarget] = useState<{
    release: HelmRelease;
    revision: number;
  } | null>(null);
  const [uninstallTarget, setUninstallTarget] = useState<HelmRelease | null>(
    null
  );
  const [historyDialog, setHistoryDialog] = useState<HelmRelease | null>(null);
  const [selectedNamespace, setSelectedNamespace] = useState<string>("all");
  const [activeTab, setActiveTab] = useState<string>("releases");

  const [addRepoDialogOpen, setAddRepoDialogOpen] = useState(false);
  const [newRepoName, setNewRepoName] = useState("");
  const [newRepoUrl, setNewRepoUrl] = useState("");
  const [deleteRepoTarget, setDeleteRepoTarget] = useState<string | null>(null);

  const [searchKeyword, setSearchKeyword] = useState("");
  const [searchResults, setSearchResults] = useState<HelmChartSearchResult[]>(
    []
  );
  const [isSearching, setIsSearching] = useState(false);

  const [installChart, setInstallChart] =
    useState<HelmChartSearchResult | null>(null);
  const [installReleaseName, setInstallReleaseName] = useState("");
  const [installNamespace, setInstallNamespace] = useState("default");
  const [installVersion, setInstallVersion] = useState("");
  const [installValues, setInstallValues] = useState("");
  const [installCreateNs, setInstallCreateNs] = useState(false);
  const [installWait, setInstallWait] = useState(true);

  const [upgradeTarget, setUpgradeTarget] = useState<HelmRelease | null>(null);
  const [upgradeVersion, setUpgradeVersion] = useState("");
  const [upgradeValues, setUpgradeValues] = useState("");
  const [upgradeWait, setUpgradeWait] = useState(true);

  useEffect(() => {
    if (isConnected && !helm) {
      checkHelmAvailability();
    }
  }, [isConnected, helm, checkHelmAvailability]);

  const { data: namespaces = [] } = useQuery({
    queryKey: ["namespaces"],
    queryFn: async () => {
      const result = await commands.listNamespaces();
      return result.map((ns) => ns.name);
    },
    enabled: isConnected,
  });

  const helmCliAvailable = helm?.available ?? false;

  const {
    data: releases = [],
    isLoading,
    refetch,
  } = useLiveQuery({
    queryKey: ["helm-releases-native", selectedNamespace],
    queryFn: async () => {
      try {
        const ns = selectedNamespace === "all" ? null : selectedNamespace;
        return await commands.listHelmReleasesNative(ns);
      } catch (err) {
        throw normalizeTauriError(err);
      }
    },
    enabled: isConnected,
    refresh: "steady",
  });

  const { data: historyData = [], isLoading: historyLoading } = useQuery({
    queryKey: ["helm-history", historyDialog?.name, historyDialog?.namespace],
    queryFn: async () => {
      if (!historyDialog) return [];
      return await commands.getHelmHistory(
        historyDialog.name,
        historyDialog.namespace
      );
    },
    enabled: !!historyDialog,
  });

  const { data: repositories = [], isLoading: reposLoading } = useQuery({
    queryKey: ["helm-repos"],
    queryFn: async () => {
      try {
        return await commands.listHelmRepos();
      } catch (err) {
        console.error("Failed to list repos:", err);
        return [];
      }
    },
    enabled: helmCliAvailable,
  });

  const rollbackMutation = useMutation({
    mutationFn: async ({
      name,
      namespace,
      revision,
    }: {
      name: string;
      namespace: string;
      revision: number;
    }) => commands.helmRollback(name, namespace, revision),
    onSuccess: () => {
      toast({
        title: "Rollback initiated",
        description:
          "The release is being rolled back to the previous revision.",
      });
      queryClient.invalidateQueries({ queryKey: ["helm-releases-native"] });
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
    mutationFn: async ({
      name,
      namespace,
    }: {
      name: string;
      namespace: string;
    }) => commands.helmUninstall(name, namespace),
    onSuccess: () => {
      toast({
        title: "Release uninstalled",
        description: "The Helm release has been successfully uninstalled.",
      });
      queryClient.invalidateQueries({ queryKey: ["helm-releases-native"] });
      setUninstallTarget(null);
    },
    onError: (error) => {
      toast({
        title: "Uninstall failed",
        description: normalizeTauriError(error),
        variant: "destructive",
      });
    },
  });

  const addRepoMutation = useMutation({
    mutationFn: async ({ name, url }: { name: string; url: string }) =>
      commands.addHelmRepo(name, url),
    onSuccess: () => {
      toast({
        title: "Repository added",
        description: `Repository "${newRepoName}" has been added successfully.`,
      });
      queryClient.invalidateQueries({ queryKey: ["helm-repos"] });
      setAddRepoDialogOpen(false);
      setNewRepoName("");
      setNewRepoUrl("");
    },
    onError: (error) => {
      toast({
        title: "Failed to add repository",
        description: normalizeTauriError(error),
        variant: "destructive",
      });
    },
  });

  const removeRepoMutation = useMutation({
    mutationFn: async (name: string) => commands.removeHelmRepo(name),
    onSuccess: () => {
      toast({
        title: "Repository removed",
        description: "The repository has been removed successfully.",
      });
      queryClient.invalidateQueries({ queryKey: ["helm-repos"] });
      setDeleteRepoTarget(null);
    },
    onError: (error) => {
      toast({
        title: "Failed to remove repository",
        description: normalizeTauriError(error),
        variant: "destructive",
      });
    },
  });

  const updateReposMutation = useMutation({
    mutationFn: async () => commands.updateHelmRepos(),
    onSuccess: () => {
      toast({
        title: "Repositories updated",
        description: "All Helm repositories have been updated.",
      });
      queryClient.invalidateQueries({ queryKey: ["helm-repos"] });
    },
    onError: (error) => {
      toast({
        title: "Failed to update repositories",
        description: normalizeTauriError(error),
        variant: "destructive",
      });
    },
  });

  const handleSearchCharts = async () => {
    if (!searchKeyword.trim()) return;
    setIsSearching(true);
    try {
      const results = await commands.helmSearchCharts(searchKeyword);
      setSearchResults(results);
    } catch (error) {
      toast({
        title: "Search failed",
        description: normalizeTauriError(error),
        variant: "destructive",
      });
    } finally {
      setIsSearching(false);
    }
  };

  const installMutation = useMutation({
    mutationFn: async (options: HelmInstallOptions) =>
      commands.helmInstall(options),
    onSuccess: () => {
      toast({
        title: "Chart installed",
        description: `Release "${installReleaseName}" has been installed successfully.`,
      });
      queryClient.invalidateQueries({ queryKey: ["helm-releases-native"] });
      setInstallChart(null);
      setInstallReleaseName("");
      setInstallNamespace("default");
      setInstallVersion("");
      setInstallValues("");
      setInstallCreateNs(false);
      setInstallWait(true);
    },
    onError: (error) => {
      toast({
        title: "Installation failed",
        description: normalizeTauriError(error),
        variant: "destructive",
      });
    },
  });

  const upgradeMutation = useMutation({
    mutationFn: async (options: HelmInstallOptions) =>
      commands.helmUpgrade(options),
    onSuccess: () => {
      toast({
        title: "Release upgraded",
        description: `Release "${upgradeTarget?.name}" has been upgraded successfully.`,
      });
      queryClient.invalidateQueries({ queryKey: ["helm-releases-native"] });
      setUpgradeTarget(null);
      setUpgradeVersion("");
      setUpgradeValues("");
      setUpgradeWait(true);
    },
    onError: (error) => {
      toast({
        title: "Upgrade failed",
        description: normalizeTauriError(error),
        variant: "destructive",
      });
    },
  });

  if (!isConnected) {
    return (
      <ConnectClusterEmptyState resourceLabel={t("empty", "helmReleases")} />
    );
  }

  return (
    <div className="flex flex-col gap-2 animate-in fade-in duration-200">
      <HelmStatusBanner />

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        {/* The window tab strip already says which screen this is, so the
            page gets the same 13px section heading as everything else —
            and the tabs sit on its right instead of under a title block.
            They stay inside the Tabs root so Radix keeps triggers and
            panels wired together. */}
        <SectionHeader
          title="Helm"
          count={t("count", "releases", { n: releases.length })}
          actions={
            <TabsList>
              <TabsTrigger value="releases">
                <Package className="h-3 w-3" aria-hidden="true" />
                Releases
              </TabsTrigger>
              <TabsTrigger value="charts" disabled={!helmCliAvailable}>
                <Search className="h-3 w-3" aria-hidden="true" />
                Charts
              </TabsTrigger>
              <TabsTrigger value="repositories" disabled={!helmCliAvailable}>
                <FolderGit2 className="h-3 w-3" aria-hidden="true" />
                Repositories
              </TabsTrigger>
            </TabsList>
          }
        />

        <TabsContent value="releases">
          <HelmReleasesTab
            releases={releases}
            isLoading={isLoading}
            helmCliAvailable={helmCliAvailable}
            namespaces={namespaces}
            selectedNamespace={selectedNamespace}
            onNamespaceChange={setSelectedNamespace}
            onRefetch={() => refetch()}
            onShowHistory={setHistoryDialog}
            onUpgrade={(release) => {
              setUpgradeTarget(release);
              setUpgradeVersion("");
              setUpgradeValues("");
            }}
            onRollback={(release) => {
              if (release.revision > 1) {
                setRollbackTarget({
                  release,
                  revision: release.revision - 1,
                });
              }
            }}
            onUninstall={setUninstallTarget}
          />
        </TabsContent>

        <TabsContent value="charts">
          <HelmChartsTab
            searchKeyword={searchKeyword}
            onSearchKeywordChange={setSearchKeyword}
            results={searchResults}
            isSearching={isSearching}
            onSearch={handleSearchCharts}
            onInstall={(chart) => {
              setInstallChart(chart);
              setInstallReleaseName(chart.name.split("/").pop() || chart.name);
              setInstallVersion(chart.version);
            }}
          />
        </TabsContent>

        <TabsContent value="repositories">
          <HelmRepositoriesTab
            repositories={repositories}
            isLoading={reposLoading}
            isUpdating={updateReposMutation.isPending}
            onUpdateAll={() => updateReposMutation.mutate()}
            onAddRepoClick={() => setAddRepoDialogOpen(true)}
            onDeleteRepo={setDeleteRepoTarget}
          />
        </TabsContent>
      </Tabs>

      <HelmAddRepoDialog
        open={addRepoDialogOpen}
        onClose={() => setAddRepoDialogOpen(false)}
        name={newRepoName}
        onNameChange={setNewRepoName}
        url={newRepoUrl}
        onUrlChange={setNewRepoUrl}
        onAdd={() =>
          addRepoMutation.mutate({ name: newRepoName, url: newRepoUrl })
        }
        isAdding={addRepoMutation.isPending}
      />

      <ConfirmDialog
        open={deleteRepoTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteRepoTarget(null);
        }}
        title="Remove Repository"
        description={`Are you sure you want to remove the repository "${deleteRepoTarget}"?`}
        confirmLabel={t("action", "remove")}
        confirmVariant="destructive"
        confirmDisabled={removeRepoMutation.isPending}
        onConfirm={() => {
          if (deleteRepoTarget) {
            removeRepoMutation.mutate(deleteRepoTarget);
          }
        }}
      />

      <HelmInstallDialog
        chart={installChart}
        onClose={() => setInstallChart(null)}
        namespaces={namespaces}
        releaseName={installReleaseName}
        onReleaseNameChange={setInstallReleaseName}
        namespace={installNamespace}
        onNamespaceChange={setInstallNamespace}
        version={installVersion}
        onVersionChange={setInstallVersion}
        values={installValues}
        onValuesChange={setInstallValues}
        createNamespace={installCreateNs}
        onCreateNamespaceChange={setInstallCreateNs}
        wait={installWait}
        onWaitChange={setInstallWait}
        onInstall={() => {
          if (installChart && installReleaseName && installNamespace) {
            installMutation.mutate({
              releaseName: installReleaseName,
              chart: installChart.name,
              namespace: installNamespace,
              version: installVersion || null,
              values: installValues || null,
              createNamespace: installCreateNs,
              wait: installWait,
              timeout: installWait ? "5m0s" : null,
            });
          }
        }}
        isInstalling={installMutation.isPending}
      />

      <HelmUpgradeDialog
        release={upgradeTarget}
        onClose={() => setUpgradeTarget(null)}
        version={upgradeVersion}
        onVersionChange={setUpgradeVersion}
        values={upgradeValues}
        onValuesChange={setUpgradeValues}
        wait={upgradeWait}
        onWaitChange={setUpgradeWait}
        onUpgrade={() => {
          if (upgradeTarget) {
            upgradeMutation.mutate({
              releaseName: upgradeTarget.name,
              chart: upgradeTarget.chart,
              namespace: upgradeTarget.namespace,
              version: upgradeVersion || null,
              values: upgradeValues || null,
              createNamespace: false,
              wait: upgradeWait,
              timeout: upgradeWait ? "5m0s" : null,
            });
          }
        }}
        isUpgrading={upgradeMutation.isPending}
      />

      {historyDialog && (
        <HelmHistoryDialog
          release={historyDialog}
          history={historyData}
          isLoading={historyLoading}
          helmCliAvailable={helmCliAvailable}
          onClose={() => setHistoryDialog(null)}
          onRollback={(revision) => {
            setRollbackTarget({ release: historyDialog, revision });
            setHistoryDialog(null);
          }}
        />
      )}

      <ConfirmDialog
        open={rollbackTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRollbackTarget(null);
        }}
        title="Rollback Release"
        description={
          rollbackTarget
            ? `Are you sure you want to rollback "${rollbackTarget.release.name}" to revision ${rollbackTarget.revision}?`
            : undefined
        }
        confirmLabel={t("action", "rollBack")}
        confirmVariant="default"
        confirmDisabled={rollbackMutation.isPending}
        onConfirm={() => {
          if (rollbackTarget) {
            rollbackMutation.mutate({
              name: rollbackTarget.release.name,
              namespace: rollbackTarget.release.namespace,
              revision: rollbackTarget.revision,
            });
          }
        }}
      />

      <DangerousConfirmDialog
        open={uninstallTarget !== null}
        onOpenChange={(open) => {
          if (!open) setUninstallTarget(null);
        }}
        title="Uninstall Release"
        description={
          uninstallTarget
            ? `This will permanently delete the Helm release "${uninstallTarget.name}" and all its resources from namespace "${uninstallTarget.namespace}". This action cannot be undone.`
            : undefined
        }
        confirmationText={uninstallTarget?.name ?? ""}
        confirmLabel={t("action", "uninstall")}
        isLoading={uninstallMutation.isPending}
        onConfirm={() => {
          if (uninstallTarget) {
            uninstallMutation.mutate({
              name: uninstallTarget.name,
              namespace: uninstallTarget.namespace,
            });
          }
        }}
      />
    </div>
  );
}

export default Helm;
