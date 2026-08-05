import { useState, useEffect } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { SettingRow, SettingsGroup } from "./settings-row";
import { useToast } from "@/components/ui/use-toast";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { commands } from "@/lib/commands";
import { useDependenciesStore } from "@/stores/dependenciesStore";
import { FolderOpen, RefreshCw } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import type { CliAvailability } from "@/generated/types";

/** What the row's hint says depends entirely on whether we found the tool. */
function availabilityHint(
  tool: CliAvailability | null,
  isChecking: boolean,
  label: string
) {
  if (isChecking || tool === null) return "Looking for the binary…";
  if (tool.available) {
    return (
      <>
        {tool.version}
        {tool.path && (
          <>
            {" · "}
            <span className="font-mono">{tool.path}</span>
          </>
        )}
      </>
    );
  }
  const searched = tool.searchedPaths?.length ?? 0;
  return searched > 0
    ? `Not on PATH — ${searched} location${searched === 1 ? "" : "s"} searched, including ${tool.searchedPaths[0]}. Set the path below.`
    : `${label} is not on PATH. Set the path below.`;
}

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

  const { data: cliPaths, isLoading } = useQuery({
    queryKey: ["cli-paths"],
    queryFn: async () => {
      const result = await commands.getCliPaths();
      setHelmPath(result.helmPath ?? "");
      setKubectlPath(result.kubectlPath ?? "");
      return result;
    },
  });

  const saveMutation = useMutation({
    mutationFn: async () => {
      await commands.saveCliPaths({
        helmPath: helmPath || undefined,
        kubectlPath: kubectlPath || undefined,
      });
    },
    onSuccess: async () => {
      toast({
        title: "CLI paths saved",
        description: "Re-checking availability…",
      });
      queryClient.invalidateQueries({ queryKey: ["cli-paths"] });
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

  const browseFor = async (title: string, setter: (value: string) => void) => {
    try {
      const selected = await open({
        multiple: false,
        directory: false,
        title,
      });
      if (selected) {
        setter(selected);
      }
    } catch {
      // User cancelled
    }
  };

  const hasChanges =
    helmPath !== (cliPaths?.helmPath ?? "") ||
    kubectlPath !== (cliPaths?.kubectlPath ?? "");

  const tools = [
    {
      id: "helm",
      label: "Helm",
      state: helm,
      recheck: checkHelmAvailability,
      path: helmPath,
      setPath: setHelmPath,
      note: null,
    },
    {
      id: "kubectl",
      label: "kubectl",
      state: kubectl,
      recheck: checkKubectlAvailability,
      path: kubectlPath,
      setPath: setKubectlPath,
      note: "Required for OIDC and other exec-based authentication.",
    },
  ] as const;

  return (
    <SettingsGroup title="CLI tools">
      {tools.map((tool) => {
        const pending = isChecking || tool.state === null;
        return (
          <SettingRow
            key={tool.id}
            label={tool.label}
            htmlFor={`${tool.id}-path`}
            hint={availabilityHint(tool.state, isChecking, tool.label)}
            control={
              <>
                <StatusBadge
                  status={
                    pending
                      ? "Checking"
                      : tool.state?.available
                        ? "Available"
                        : "Not found"
                  }
                  roleOverride={
                    pending ? "pending" : tool.state?.available ? "ok" : "warn"
                  }
                />
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Re-check ${tool.label}`}
                  onClick={() => tool.recheck()}
                  disabled={isChecking}
                >
                  <RefreshCw
                    className={`h-3.5 w-3.5 ${isChecking ? "animate-spin" : ""}`}
                  />
                </Button>
              </>
            }
          >
            <div className="flex gap-1.5">
              <Input
                id={`${tool.id}-path`}
                placeholder={`/path/to/${tool.id} — leave empty to auto-detect`}
                value={tool.path}
                onChange={(e) => tool.setPath(e.target.value)}
                className="font-mono"
              />
              <Button
                variant="outline"
                size="icon"
                aria-label={`Browse for the ${tool.label} binary`}
                onClick={() =>
                  browseFor(`Select ${tool.label} binary`, tool.setPath)
                }
              >
                <FolderOpen className="h-3.5 w-3.5" />
              </Button>
            </div>
            {tool.note && (
              <p className="mt-1 text-[11px] text-fg-mut">{tool.note}</p>
            )}
          </SettingRow>
        );
      })}
      <div className="flex justify-end pt-2">
        <Button
          size="sm"
          onClick={() => saveMutation.mutate()}
          disabled={!hasChanges || saveMutation.isPending || isLoading}
        >
          {saveMutation.isPending ? "Saving…" : "Save paths"}
        </Button>
      </div>
    </SettingsGroup>
  );
}
