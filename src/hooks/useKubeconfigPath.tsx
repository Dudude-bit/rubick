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
import { useT } from "@/i18n/useT";
import { commands } from "@/lib/commands";
import { useClusterStore } from "@/stores/clusterStore";

export function useKubeconfigPath() {
  const { toast } = useToast();
  const t = useT();
  const queryClient = useQueryClient();

  const override = useQuery({
    queryKey: ["kubeconfig-path"],
    queryFn: () => commands.getKubeconfigPath(),
  });

  // Every pinned file, in the order they merge. One file is the common case
  // and reads the same as it always did; several is what a reader with a
  // work cluster and a home cluster asked for, rather than pasting both into
  // one file.
  const pinned = useQuery({
    queryKey: ["kubeconfig-paths"],
    queryFn: () => commands.getKubeconfigPaths(),
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
    queryClient.invalidateQueries({ queryKey: ["kubeconfig-paths"] });
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
  const restore = async (previous: string[] | string | null) => {
    const list =
      previous === null ? [] : Array.isArray(previous) ? previous : [previous];
    try {
      if (list.length > 0) await commands.setKubeconfigPaths(list);
      else await commands.clearKubeconfigPath();
      await reload();
      toast({
        title: t("settings", "kubeconfigRestored"),
        description:
          list.length > 0
            ? list.join(", ")
            : t("settings", "backToDefaultLookup"),
      });
    } catch (error) {
      failed(t("settings", "restorePreviousFailed"))(error);
    }
  };

  const undo = (previous: string[] | string | null) => (
    <ToastAction
      altText={t("settings", "undoKubeconfigChange")}
      onClick={() => void restore(previous)}
    >
      {t("action", "undo")}
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
        title: t("settings", "kubeconfigUpdated"),
        description: context.previous
          ? t("settings", "wasPath", { path: context.previous })
          : t("settings", "wasDefaultLookup"),
        action: undo(context.previous),
      });
    },
    onError: failed(t("settings", "setKubeconfigFailed")),
  });

  /**
   * The whole list at once, which is the only statement that says what the
   * app will read: the files merge, and merging depends on the order.
   */
  const setPaths = useMutation({
    mutationFn: (paths: string[]) => commands.setKubeconfigPaths(paths),
    onMutate: () => ({ previous: pinned.data ?? [] }),
    onSuccess: async (_result, paths, context) => {
      await reload();
      toast({
        title: t("settings", "kubeconfigUpdated"),
        description:
          context.previous.length > 0
            ? t("settings", "wasPath", { path: context.previous.join(", ") })
            : t("settings", "wasDefaultLookup"),
        action: undo(paths.length === 0 ? null : context.previous),
      });
    },
    onError: failed(t("settings", "setKubeconfigFailed")),
  });

  const clearPath = useMutation({
    mutationFn: () => commands.clearKubeconfigPath(),
    onMutate: () => ({ previous: override.data ?? null }),
    onSuccess: async (_result, _vars, context) => {
      await reload();
      toast({
        title: t("settings", "kubeconfigUpdated"),
        description: t("settings", "revertedToDefault"),
        action: context.previous ? undo(context.previous) : undefined,
      });
    },
    onError: failed(t("settings", "clearKubeconfigFailed")),
  });

  /** Pick a file and pin the app to it. A cancelled dialog changes nothing. */
  const choose = async () => {
    const selected = await open({
      multiple: false,
      directory: false,
      title: t("settings", "selectKubeconfigFile"),
    }).catch(() => null);
    if (typeof selected === "string") setPath.mutate(selected);
    return typeof selected === "string" ? selected : null;
  };

  /**
   * Pick one or more files and add them to what is already pinned.
   *
   * Adding rather than replacing: the reader who has a work file pinned and
   * reaches for this wants their home file too, not instead. A file already
   * in the list is not added twice — the merge would ignore the second copy
   * anyway, and a list with the same path on it twice reads as a mistake.
   */
  const add = async () => {
    const selected = await open({
      multiple: true,
      directory: false,
      title: t("settings", "selectKubeconfigFile"),
    }).catch(() => null);
    const chosen = Array.isArray(selected)
      ? selected
      : typeof selected === "string"
        ? [selected]
        : [];
    if (chosen.length === 0) return;
    // What the app reads right now, which is not the same as what is
    // pinned: with nothing pinned it is reading `$KUBECONFIG` or the
    // default path, and starting from the empty pin list would make Add a
    // file mean replace this file — quietly dropping the clusters the
    // reader could see a second ago.
    const current =
      pinned.data && pinned.data.length > 0
        ? pinned.data
        : (source.data?.candidates ?? [])
            .filter((candidate) => candidate.exists)
            .map((candidate) => candidate.path);
    const merged = [...current];
    for (const path of chosen) {
      if (!merged.includes(path)) merged.push(path);
    }
    if (merged.length !== current.length) setPaths.mutate(merged);
  };

  /** Stop reading this file. Removing the last one goes back to the lookup. */
  const remove = (path: string) => {
    const rest = (pinned.data ?? []).filter((entry) => entry !== path);
    setPaths.mutate(rest);
  };

  return {
    /** The pinned path, or null when the default lookup is in use. */
    overridePath: override.data ?? null,
    /** Every pinned file, in merge order. Empty means the default lookup. */
    paths: pinned.data ?? [],
    /** Where the app looked, and what it found. */
    source: source.data,
    isLoading: override.isLoading || source.isLoading || pinned.isLoading,
    isPending: setPath.isPending || clearPath.isPending || setPaths.isPending,
    choose,
    add,
    remove,
    setPath: setPath.mutate,
    setPaths: setPaths.mutate,
    clearPath: clearPath.mutate,
    reload,
  };
}
