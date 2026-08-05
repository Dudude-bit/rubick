import { useState } from "react";
import { Section, SectionHeader } from "@/components/ui/section";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useClusterStore } from "@/stores/clusterStore";
import { useDependenciesStore } from "@/stores/dependenciesStore";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DangerousConfirmDialog } from "@/components/ui/dangerous-confirm-dialog";
import { YamlEditor } from "@/components/yaml/YamlEditor";
import { useToast } from "@/components/ui/use-toast";
import {
  ArrowLeft,
  RefreshCw,
  Trash2,
  RotateCcw,
  Clock,
  Package,
  History,
  Anchor,
} from "lucide-react";
import { commands } from "@/lib/commands";
import { normalizeTauriError } from "@/lib/error-utils";
import { cn } from "@/lib/utils";

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
  const [activeTab, setActiveTab] = useState("overview");

  const isNative = source === "native";
  const helmCliAvailable = helm?.available ?? false;

  // Fetch release detail
  const {
    data: release,
    isLoading,
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

  // Fetch history
  const { data: history = [], isLoading: historyLoading } = useQuery({
    queryKey: ["helm-history", name, namespace],
    queryFn: async () => {
      if (!namespace || !name) return [];
      return await commands.getHelmHistory(name, namespace);
    },
    enabled: isConnected && !!namespace && !!name && isNative,
  });

  // Rollback mutation
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

  // Uninstall mutation
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
      <div className="p-4 text-center text-muted-foreground">
        Connect to a cluster to view Helm release details.
      </div>
    );
  }

  if (!isNative) {
    // Redirect to CRD view for Flux releases
    return (
      <div className="p-4 space-y-4">
        <Button variant="ghost" onClick={() => navigate("/helm")}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back to Helm Releases
        </Button>
        <Section>
          <div className="p-6 text-center">
            <Anchor className="h-12 w-12 mx-auto text-purple-500 mb-4" />
            <h2 className="text-xl font-semibold mb-2">Flux HelmRelease</h2>
            <p className="text-muted-foreground mb-4">
              This is a Flux CD managed HelmRelease. View it in the CRD browser.
            </p>
            <Button
              onClick={() =>
                navigate(
                  `/crds/helm.toolkit.fluxcd.io/helmreleases/${namespace}/${name}`
                )
              }
            >
              View in CRD Browser
            </Button>
          </div>
        </Section>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="p-4 text-center text-muted-foreground">
        Loading release details...
      </div>
    );
  }

  if (error || !release) {
    return (
      <div className="p-4 space-y-4">
        <Button variant="ghost" onClick={() => navigate("/helm")}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back to Helm Releases
        </Button>
        <Section>
          <div className="p-6 text-center text-destructive">
            {error ? normalizeTauriError(error) : "Release not found"}
          </div>
        </Section>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => navigate("/helm")}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <div className="flex items-center gap-2">
              <Package className="h-5 w-5 text-blue-500" />
              <h1 className="text-2xl font-bold">{release.name}</h1>
              <StatusBadge status={release.status} showDot />
            </div>
            <p className="text-sm text-muted-foreground">
              {release.namespace} • {release.chart}:{release.chartVersion}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="icon"
            onClick={() => refetch()}
            disabled={isLoading}
          >
            <RefreshCw className={cn("h-4 w-4", isLoading && "animate-spin")} />
          </Button>
          {helmCliAvailable && (
            <>
              <Button
                variant="outline"
                onClick={() => setRollbackTarget(release.revision - 1)}
                disabled={release.revision <= 1}
              >
                <RotateCcw className="mr-2 h-4 w-4" />
                Rollback
              </Button>
              <Button
                variant="destructive"
                onClick={() => setShowUninstall(true)}
              >
                <Trash2 className="mr-2 h-4 w-4" />
                Uninstall
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="values">Values</TabsTrigger>
          <TabsTrigger value="manifest">Manifest</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
          {release.notes && <TabsTrigger value="notes">Notes</TabsTrigger>}
        </TabsList>

        <TabsContent value="overview" className="space-y-4">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <InfoCard
              icon={Package}
              label="Chart"
              value={`${release.chart}:${release.chartVersion}`}
            />
            <InfoCard
              icon={Clock}
              label="App Version"
              value={release.appVersion || "-"}
            />
            <InfoCard
              icon={History}
              label="Revision"
              value={String(release.revision)}
            />
            <InfoCard
              icon={Clock}
              label="Last Deployed"
              value={
                release.lastDeployed
                  ? new Date(release.lastDeployed).toLocaleString()
                  : "-"
              }
            />
          </div>

          {release.description && (
            <Section>
              <SectionHeader title="Description" />
              <div>
                <p className="text-sm text-muted-foreground">
                  {release.description}
                </p>
              </div>
            </Section>
          )}

          <Section>
            <SectionHeader title="Deployment Info" />
            <div className="space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Status</span>
                <StatusBadge status={release.status} />
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Namespace</span>
                <span>{release.namespace}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">First Deployed</span>
                <span>
                  {release.firstDeployed
                    ? new Date(release.firstDeployed).toLocaleString()
                    : "-"}
                </span>
              </div>
            </div>
          </Section>
        </TabsContent>

        <TabsContent value="values">
          <Section>
            <SectionHeader title="Values (YAML)" />
            <div>
              <YamlEditor
                value={formatYaml(release.values)}
                readOnly
                height="600px"
                className="rounded-lg overflow-hidden"
              />
            </div>
          </Section>
        </TabsContent>

        <TabsContent value="manifest">
          <Section>
            <SectionHeader title="Rendered Manifest" />
            <div>
              <YamlEditor
                value={release.manifest || "# No manifest available"}
                readOnly
                height="600px"
                className="rounded-lg overflow-hidden"
              />
            </div>
          </Section>
        </TabsContent>

        <TabsContent value="history">
          <Section>
            <SectionHeader title="Release History" />
            <div>
              {historyLoading ? (
                <p className="text-sm text-muted-foreground">Loading...</p>
              ) : history.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No history available
                </p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b">
                      <th className="text-left p-2">Revision</th>
                      <th className="text-left p-2">Status</th>
                      <th className="text-left p-2">Chart</th>
                      <th className="text-left p-2">Updated</th>
                      <th className="text-left p-2">Description</th>
                      <th className="text-right p-2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((rev) => (
                      <tr
                        key={rev.revision}
                        className={cn(
                          "border-b last:border-0",
                          rev.revision === release.revision && "bg-muted/50"
                        )}
                      >
                        <td className="p-2 font-medium">
                          {rev.revision}
                          {rev.revision === release.revision && (
                            <span className="ml-2 text-xs text-muted-foreground">
                              (current)
                            </span>
                          )}
                        </td>
                        <td className="p-2">
                          <StatusBadge status={rev.status} />
                        </td>
                        <td className="p-2 text-muted-foreground">
                          {rev.chart}
                        </td>
                        <td className="p-2 text-muted-foreground">
                          {rev.updated
                            ? new Date(rev.updated).toLocaleString()
                            : "-"}
                        </td>
                        <td className="p-2 text-muted-foreground truncate max-w-[200px]">
                          {rev.description || "-"}
                        </td>
                        <td className="p-2 text-right">
                          {rev.revision < release.revision &&
                            helmCliAvailable && (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setRollbackTarget(rev.revision)}
                              >
                                <RotateCcw className="h-3 w-3 mr-1" />
                                Rollback
                              </Button>
                            )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </Section>
        </TabsContent>

        {release.notes && (
          <TabsContent value="notes">
            <Section>
              <SectionHeader title="Release Notes" />
              <div>
                <pre className="text-xs bg-muted p-4 rounded-lg overflow-auto max-h-[600px] font-mono whitespace-pre-wrap">
                  {release.notes}
                </pre>
              </div>
            </Section>
          </TabsContent>
        )}
      </Tabs>

      {/* Rollback confirmation */}
      <ConfirmDialog
        open={rollbackTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRollbackTarget(null);
        }}
        title="Rollback Release"
        description={`Are you sure you want to rollback "${release.name}" to revision ${rollbackTarget}?`}
        confirmLabel="Rollback"
        confirmVariant="default"
        confirmDisabled={rollbackMutation.isPending}
        onConfirm={() => {
          if (rollbackTarget !== null) {
            rollbackMutation.mutate(rollbackTarget);
          }
        }}
      />

      {/* Uninstall confirmation */}
      <DangerousConfirmDialog
        open={showUninstall}
        onOpenChange={setShowUninstall}
        title="Uninstall Release"
        description={`This will permanently delete the Helm release "${release.name}" and all its resources from namespace "${release.namespace}". This action cannot be undone.`}
        confirmationText={release.name}
        confirmLabel="Uninstall"
        isLoading={uninstallMutation.isPending}
        onConfirm={() => uninstallMutation.mutate()}
      />
    </div>
  );
}

// Info card component
interface InfoCardProps {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
}

function InfoCard({ icon: Icon, label, value }: InfoCardProps) {
  return (
    <Section>
      <div className="p-4">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-muted rounded-lg">
            <Icon className="h-4 w-4 text-muted-foreground" />
          </div>
          <div>
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className="text-sm font-medium truncate">{value}</p>
          </div>
        </div>
      </div>
    </Section>
  );
}

// Format values as YAML
function formatYaml(values: unknown): string {
  if (!values) return "# No values configured";
  if (typeof values === "string") return values;
  try {
    // Use YAML-like format (JSON with 2-space indent works for viewing)
    return JSON.stringify(values, null, 2)
      .replace(/"([^"]+)":/g, "$1:") // Remove quotes from keys
      .replace(/"([^"]+)"/g, "$1"); // Remove quotes from string values
  } catch {
    return String(values);
  }
}

export default HelmDetail;
