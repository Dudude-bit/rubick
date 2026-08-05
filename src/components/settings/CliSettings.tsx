import { useState, useEffect } from "react";
import { Section, SectionHeader } from "@/components/ui/section";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/components/ui/use-toast";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { commands } from "@/lib/commands";
import { useDependenciesStore } from "@/stores/dependenciesStore";
import {
  CheckCircle2,
  XCircle,
  FolderOpen,
  RefreshCw,
  AlertCircle,
  Loader2,
} from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";

export function CliSettings() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const {
    helm,
    kubectl,
    checkHelmAvailability,
    checkKubectlAvailability,
    isChecking,
  } = useDependenciesStore();
  const [helmPath, setHelmPath] = useState<string>("");
  const [kubectlPath, setKubectlPath] = useState<string>("");

  // Auto-check availability on mount if not yet checked
  useEffect(() => {
    if (helm === null && !isChecking) {
      checkHelmAvailability();
    }
    if (kubectl === null && !isChecking) {
      checkKubectlAvailability();
    }
  }, [
    helm,
    kubectl,
    isChecking,
    checkHelmAvailability,
    checkKubectlAvailability,
  ]);

  // Load current CLI paths config
  const { data: cliPaths, isLoading } = useQuery({
    queryKey: ["cli-paths"],
    queryFn: async () => {
      const result = await commands.getCliPaths();
      setHelmPath(result.helmPath ?? "");
      setKubectlPath(result.kubectlPath ?? "");
      return result;
    },
  });

  // Save CLI paths
  const saveMutation = useMutation({
    mutationFn: async () => {
      await commands.saveCliPaths({
        helmPath: helmPath || undefined,
        kubectlPath: kubectlPath || undefined,
      });
    },
    onSuccess: async () => {
      toast({
        title: "Settings saved",
        description: "CLI paths have been updated. Checking availability...",
      });
      queryClient.invalidateQueries({ queryKey: ["cli-paths"] });
      // Re-check availability after saving
      await Promise.all([checkHelmAvailability(), checkKubectlAvailability()]);
    },
    onError: (error) => {
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      });
    },
  });

  // Browse for helm binary
  const handleBrowseHelm = async () => {
    try {
      const selected = await open({
        multiple: false,
        directory: false,
        title: "Select Helm Binary",
      });
      if (selected) {
        setHelmPath(selected);
      }
    } catch {
      // User cancelled
    }
  };

  // Browse for kubectl binary
  const handleBrowseKubectl = async () => {
    try {
      const selected = await open({
        multiple: false,
        directory: false,
        title: "Select kubectl Binary",
      });
      if (selected) {
        setKubectlPath(selected);
      }
    } catch {
      // User cancelled
    }
  };

  const hasChanges =
    helmPath !== (cliPaths?.helmPath ?? "") ||
    kubectlPath !== (cliPaths?.kubectlPath ?? "");

  return (
    <Section>
      <SectionHeader
        title="CLI Tools"
        description="Configure paths to external CLI tools. If a tool is not found automatically, you can specify the path manually."
      />
      <div className="flex flex-col gap-6">
        {/* Helm CLI Section */}
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <h4 className="text-[13px] font-medium text-fg-mid">Helm CLI</h4>
              {isChecking || helm === null ? (
                <Badge variant="secondary">
                  <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                  Checking...
                </Badge>
              ) : helm.available ? (
                <Badge
                  variant="default"
                  className="bg-green-500/10 text-green-500 hover:bg-green-500/20"
                >
                  <CheckCircle2 className="h-3 w-3 mr-1" />
                  Available
                </Badge>
              ) : (
                <Badge variant="destructive">
                  <XCircle className="h-3 w-3 mr-1" />
                  Not Found
                </Badge>
              )}
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => checkHelmAvailability()}
              disabled={isChecking}
            >
              <RefreshCw
                className={`h-4 w-4 ${isChecking ? "animate-spin" : ""}`}
              />
            </Button>
          </div>

          {helm?.available && (
            <div className="text-sm text-muted-foreground space-y-1">
              <div>
                Version: <span className="font-mono">{helm.version}</span>
              </div>
              {helm.path && (
                <div>
                  Path: <span className="font-mono text-xs">{helm.path}</span>
                </div>
              )}
            </div>
          )}

          {!helm?.available &&
            helm?.searchedPaths &&
            helm.searchedPaths.length > 0 && (
              <div className="rounded-md border p-3 bg-muted/50">
                <div className="flex items-start gap-2 text-sm">
                  <AlertCircle className="h-4 w-4 text-yellow-500 mt-0.5 shrink-0" />
                  <div className="space-y-2">
                    <p className="text-muted-foreground">
                      Helm was not found in any of the following paths:
                    </p>
                    <ul className="text-xs font-mono text-muted-foreground list-disc list-inside">
                      {helm.searchedPaths.slice(0, 5).map((path, i) => (
                        <li key={i}>{path}</li>
                      ))}
                      {helm.searchedPaths.length > 5 && (
                        <li>... and {helm.searchedPaths.length - 5} more</li>
                      )}
                    </ul>
                  </div>
                </div>
              </div>
            )}

          <div className="space-y-2">
            <Label htmlFor="helm-path">Custom Helm Path</Label>
            <div className="flex gap-2">
              <Input
                id="helm-path"
                placeholder="/path/to/helm (leave empty for auto-detection)"
                value={helmPath}
                onChange={(e) => setHelmPath(e.target.value)}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
              />
              <Button variant="outline" size="icon" onClick={handleBrowseHelm}>
                <FolderOpen className="h-4 w-4" />
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Specify the full path to the helm binary if it's not in your PATH
            </p>
          </div>
        </div>

        <Separator />

        {/* kubectl CLI Section */}
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <h4 className="text-[13px] font-medium text-fg-mid">
                kubectl CLI
              </h4>
              {isChecking || kubectl === null ? (
                <Badge variant="secondary">
                  <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                  Checking...
                </Badge>
              ) : kubectl.available ? (
                <Badge
                  variant="default"
                  className="bg-green-500/10 text-green-500 hover:bg-green-500/20"
                >
                  <CheckCircle2 className="h-3 w-3 mr-1" />
                  Available
                </Badge>
              ) : (
                <Badge variant="destructive">
                  <XCircle className="h-3 w-3 mr-1" />
                  Not Found
                </Badge>
              )}
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => checkKubectlAvailability()}
              disabled={isChecking}
            >
              <RefreshCw
                className={`h-4 w-4 ${isChecking ? "animate-spin" : ""}`}
              />
            </Button>
          </div>

          {kubectl?.available && (
            <div className="text-sm text-muted-foreground space-y-1">
              <div>
                Version: <span className="font-mono">{kubectl.version}</span>
              </div>
              {kubectl.path && (
                <div>
                  Path:{" "}
                  <span className="font-mono text-xs">{kubectl.path}</span>
                </div>
              )}
            </div>
          )}

          {!kubectl?.available &&
            kubectl?.searchedPaths &&
            kubectl.searchedPaths.length > 0 && (
              <div className="rounded-md border p-3 bg-muted/50">
                <div className="flex items-start gap-2 text-sm">
                  <AlertCircle className="h-4 w-4 text-yellow-500 mt-0.5 shrink-0" />
                  <div className="space-y-2">
                    <p className="text-muted-foreground">
                      kubectl was not found in any of the following paths:
                    </p>
                    <ul className="text-xs font-mono text-muted-foreground list-disc list-inside">
                      {kubectl.searchedPaths.slice(0, 5).map((path, i) => (
                        <li key={i}>{path}</li>
                      ))}
                      {kubectl.searchedPaths.length > 5 && (
                        <li>... and {kubectl.searchedPaths.length - 5} more</li>
                      )}
                    </ul>
                  </div>
                </div>
              </div>
            )}

          <div className="space-y-2">
            <Label htmlFor="kubectl-path">Custom kubectl Path</Label>
            <div className="flex gap-2">
              <Input
                id="kubectl-path"
                placeholder="/path/to/kubectl (leave empty for auto-detection)"
                value={kubectlPath}
                onChange={(e) => setKubectlPath(e.target.value)}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
              />
              <Button
                variant="outline"
                size="icon"
                onClick={handleBrowseKubectl}
              >
                <FolderOpen className="h-4 w-4" />
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Specify the full path to the kubectl binary if it's not in your
              PATH. This is required for OIDC and other exec-based
              authentication methods.
            </p>
          </div>
        </div>

        <Separator />

        <div className="flex justify-end">
          <Button
            onClick={() => saveMutation.mutate()}
            disabled={!hasChanges || saveMutation.isPending || isLoading}
          >
            {saveMutation.isPending ? "Saving..." : "Save Changes"}
          </Button>
        </div>
      </div>
    </Section>
  );
}
