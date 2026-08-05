import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { SettingRow, SettingsGroup } from "./settings-row";
import { useToast } from "@/components/ui/use-toast";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { commands } from "@/lib/commands";
import { FolderOpen, RotateCcw } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";

/**
 * Lets the user override the kubeconfig path used by the app. By
 * default the backend reads `$KUBECONFIG` or `~/.kube/config` (same
 * as kubectl). Setting a path here pins the app to that file across
 * restarts and is the supported way to test against a synthetic
 * kubeconfig without touching `~/.kube/config`.
 *
 * On save we invalidate the context list and disconnect any active
 * cluster — the cached clients are bound to the previous kubeconfig.
 */
export function KubeconfigSettings() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [pathInput, setPathInput] = useState<string>("");

  const { data: currentPath, isLoading } = useQuery({
    queryKey: ["kubeconfig-path"],
    queryFn: async () => {
      const result = await commands.getKubeconfigPath();
      setPathInput(result ?? "");
      return result;
    },
  });

  const onSettled = async (description: string) => {
    queryClient.invalidateQueries({ queryKey: ["kubeconfig-path"] });
    // The cluster list and any cached connections depend on which
    // kubeconfig is active — drop them so the next read repopulates
    // from the new file.
    queryClient.invalidateQueries({ queryKey: ["contexts"] });
    queryClient.invalidateQueries({ queryKey: ["current-context"] });
    toast({
      title: "Kubeconfig updated",
      description,
    });
  };

  const setMutation = useMutation({
    mutationFn: async (path: string) => {
      await commands.setKubeconfigPath(path);
    },
    onSuccess: () => onSettled("Using custom kubeconfig path."),
    onError: (error) => {
      toast({
        title: "Failed to set kubeconfig path",
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      });
    },
  });

  const clearMutation = useMutation({
    mutationFn: async () => {
      await commands.clearKubeconfigPath();
    },
    onSuccess: () => {
      setPathInput("");
      return onSettled("Reverted to default kubeconfig lookup.");
    },
    onError: (error) => {
      toast({
        title: "Failed to clear kubeconfig override",
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      });
    },
  });

  const handleBrowse = async () => {
    try {
      const selected = await open({
        multiple: false,
        directory: false,
        title: "Select kubeconfig file",
      });
      if (typeof selected === "string") {
        setPathInput(selected);
      }
    } catch {
      // User cancelled
    }
  };

  const isPending = setMutation.isPending || clearMutation.isPending;
  const hasChanges = pathInput !== (currentPath ?? "");

  return (
    <SettingsGroup title="Kubeconfig">
      <SettingRow
        label="Custom kubeconfig path"
        htmlFor="kubeconfig-path"
        hint={
          currentPath ? (
            <>
              Active: <span className="font-mono">{currentPath}</span>
            </>
          ) : (
            "Using the default lookup ($KUBECONFIG, then ~/.kube/config)."
          )
        }
        control={
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => clearMutation.mutate()}
              disabled={isPending || isLoading || !currentPath}
            >
              <RotateCcw className="mr-1.5 h-3 w-3" aria-hidden="true" />
              Reset
            </Button>
            <Button
              size="sm"
              onClick={() => setMutation.mutate(pathInput)}
              disabled={isPending || isLoading || !hasChanges || !pathInput}
            >
              {setMutation.isPending ? "Saving…" : "Save"}
            </Button>
          </>
        }
      >
        <div className="flex gap-1.5">
          <Input
            id="kubeconfig-path"
            placeholder="Leave empty to use the default lookup"
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            disabled={isPending || isLoading}
            className="font-mono"
          />
          <Button
            variant="outline"
            size="icon"
            aria-label="Browse for a kubeconfig file"
            onClick={handleBrowse}
            disabled={isPending || isLoading}
          >
            <FolderOpen className="h-3.5 w-3.5" />
          </Button>
        </div>
      </SettingRow>
    </SettingsGroup>
  );
}
