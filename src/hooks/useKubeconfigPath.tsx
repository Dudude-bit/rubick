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

import { ToastAction } from "@/components/ui/toast";
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

  /**
   * Put back whatever was in force before. Both surfaces apply a path
   * without asking for confirmation, so both owe the reader a way back
   * that does not require having memorised the old value.
   */
  const restore = async (previous: string | null) => {
    try {
      if (previous) await commands.setKubeconfigPath(previous);
      else await commands.clearKubeconfigPath();
      await reload();
      toast({
        title: "Kubeconfig restored",
        description: previous ?? "Back to the default lookup.",
      });
    } catch (error) {
      failed("Failed to restore the previous kubeconfig")(error);
    }
  };

  const undo = (previous: string | null) => (
    <ToastAction
      altText="Undo the kubeconfig change"
      onClick={() => void restore(previous)}
    >
      Undo
    </ToastAction>
  );

  const setPath = useMutation({
    mutationFn: (path: string) => commands.setKubeconfigPath(path),
    // Captured before the write, because the query it comes from is
    // invalidated by `reload` before the toast is built.
    onMutate: () => ({ previous: override.data ?? null }),
    onSuccess: async (_result, _path, context) => {
      await reload();
      toast({
        title: "Kubeconfig updated",
        description: context.previous
          ? `Was ${context.previous}.`
          : "Was the default lookup.",
        action: undo(context.previous),
      });
    },
    onError: failed("Failed to set kubeconfig path"),
  });

  const clearPath = useMutation({
    mutationFn: () => commands.clearKubeconfigPath(),
    onMutate: () => ({ previous: override.data ?? null }),
    onSuccess: async (_result, _vars, context) => {
      await reload();
      toast({
        title: "Kubeconfig updated",
        description: "Reverted to the default lookup.",
        action: context.previous ? undo(context.previous) : undefined,
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
