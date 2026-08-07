/**
 * The kubeconfig the app is reading, and the two ways to change it.
 *
 * "Why is my cluster not listed" is almost always the wrong file, so this
 * has to be answerable from the screen that has no clusters as well as
 * from Settings. Both surfaces read and write the same thing, so both use
 * this — the alternative is two dialogs, two mutations and two ideas of
 * what "reload" means.
 *
 * @module hooks/useKubeconfigPath
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { open } from "@tauri-apps/plugin-dialog";

import { useToast } from "@/components/ui/use-toast";
import { commands } from "@/lib/commands";
import { useClusterStore } from "@/stores/clusterStore";

export function useKubeconfigPath() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const override = useQuery({
    queryKey: ["kubeconfig-path"],
    queryFn: () => commands.getKubeconfigPath(),
  });

  const source = useQuery({
    queryKey: ["kubeconfig-source"],
    queryFn: () => commands.getKubeconfigSource(),
  });

  /**
   * Both the cached clients and the context list are bound to whichever
   * kubeconfig was active, so nothing survives the file changing.
   */
  const reload = () => {
    queryClient.invalidateQueries({ queryKey: ["kubeconfig-path"] });
    queryClient.invalidateQueries({ queryKey: ["kubeconfig-source"] });
    queryClient.invalidateQueries({ queryKey: ["contexts"] });
    queryClient.invalidateQueries({ queryKey: ["current-context"] });
    return useClusterStore.getState().loadContexts();
  };

  const failed = (title: string) => (error: unknown) =>
    toast({
      title,
      description: error instanceof Error ? error.message : String(error),
      variant: "destructive",
    });

  const setPath = useMutation({
    mutationFn: (path: string) => commands.setKubeconfigPath(path),
    onSuccess: async () => {
      await reload();
      toast({
        title: "Kubeconfig updated",
        description: "Using custom kubeconfig path.",
      });
    },
    onError: failed("Failed to set kubeconfig path"),
  });

  const clearPath = useMutation({
    mutationFn: () => commands.clearKubeconfigPath(),
    onSuccess: async () => {
      await reload();
      toast({
        title: "Kubeconfig updated",
        description: "Reverted to default kubeconfig lookup.",
      });
    },
    onError: failed("Failed to clear kubeconfig override"),
  });

  /** Pick a file and pin the app to it. A cancelled dialog changes nothing. */
  const choose = async () => {
    const selected = await open({
      multiple: false,
      directory: false,
      title: "Select kubeconfig file",
    }).catch(() => null);
    if (typeof selected === "string") setPath.mutate(selected);
    return typeof selected === "string" ? selected : null;
  };

  return {
    /** The pinned path, or null when the default lookup is in use. */
    overridePath: override.data ?? null,
    /** Where the app looked, and what it found. */
    source: source.data,
    isLoading: override.isLoading || source.isLoading,
    isPending: setPath.isPending || clearPath.isPending,
    choose,
    setPath: setPath.mutate,
    clearPath: clearPath.mutate,
    reload,
  };
}
