import { useState } from "react";
import { Section, SectionHeader } from "@/components/ui/section";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
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
    <Section>
      <SectionHeader
        title="Kubeconfig"
        description={
          <>
            By default the app reads <code>$KUBECONFIG</code> or{" "}
            <code>~/.kube/config</code>. Set a custom path here to point at a
            different file — useful for testing against a synthetic kubeconfig
            without touching your default one.
          </>
        }
      />
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Label htmlFor="kubeconfig-path">Custom kubeconfig path</Label>
          <div className="flex gap-2">
            <Input
              id="kubeconfig-path"
              placeholder="Leave empty to use default lookup (~/.kube/config)"
              value={pathInput}
              onChange={(e) => setPathInput(e.target.value)}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              disabled={isPending || isLoading}
            />
            <Button
              variant="outline"
              size="icon"
              onClick={handleBrowse}
              disabled={isPending || isLoading}
            >
              <FolderOpen className="h-4 w-4" />
            </Button>
          </div>
          {currentPath ? (
            <p className="text-xs text-fg-mut">
              Currently active: <span className="font-mono">{currentPath}</span>
            </p>
          ) : (
            <p className="text-xs text-fg-mut">
              Currently using default lookup ($KUBECONFIG / ~/.kube/config).
            </p>
          )}
        </div>

        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            onClick={() => clearMutation.mutate()}
            disabled={isPending || isLoading || !currentPath}
          >
            <RotateCcw className="h-4 w-4 mr-2" />
            Reset to default
          </Button>
          <Button
            onClick={() => setMutation.mutate(pathInput)}
            disabled={isPending || isLoading || !hasChanges || !pathInput}
          >
            {setMutation.isPending ? "Saving..." : "Save"}
          </Button>
        </div>
      </div>
    </Section>
  );
}
