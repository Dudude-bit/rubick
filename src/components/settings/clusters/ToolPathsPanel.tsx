import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { open } from "@tauri-apps/plugin-dialog";
import { FolderOpen, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StatusBadge } from "@/components/ui/status-badge";
import { useToast } from "@/components/ui/use-toast";
import type { CliAvailability } from "@/generated/types";
import { commands } from "@/lib/commands";
import { useDependenciesStore } from "@/stores/dependenciesStore";
import { SettingRow } from "../settings-row";
import { useT, type T } from "@/i18n/useT";

/** What the row's hint says depends entirely on whether we found the tool. */
function availabilityHint(
  tool: CliAvailability | null,
  isChecking: boolean,
  label: string,
  t: T
) {
  if (isChecking || tool === null) return t("settings", "lookingForBinary");
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

/**
 * Overriding where a binary lives, which almost nobody does.
 *
 * These were three full-width fields taking a third of the Clusters pane
 * to say "leave me empty". The fact worth reading — which version, from
 * where — is on the pane itself now; this is the rare correction, and a
 * rare correction is a link.
 *
 * A path here applies when you leave the field, and the re-check is the
 * feedback: the badge either turns green with a version or does not.
 */
export function ToolPathsPanel() {
  const t = useT();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const {
    helm,
    kubectl,
    checkHelmAvailability,
    checkKubectlAvailability,
    isChecking,
  } = useDependenciesStore();
  // Null means "showing what is saved". The field only takes over once it
  // has been edited, so a re-check that changes the stored path is
  // reflected instead of being pinned to whatever was on screen.
  const [typed, setTyped] = useState<Record<string, string | undefined>>({});

  const { data: cliPaths } = useQuery({
    queryKey: ["cli-paths"],
    queryFn: commands.getCliPaths,
  });

  const helmPath = typed.helm ?? cliPaths?.helmPath ?? "";
  const kubectlPath = typed.kubectl ?? cliPaths?.kubectlPath ?? "";
  const setHelmPath = (value: string) =>
    setTyped((prev) => ({ ...prev, helm: value }));
  const setKubectlPath = (value: string) =>
    setTyped((prev) => ({ ...prev, kubectl: value }));

  const save = useMutation({
    mutationFn: (paths: { helmPath: string; kubectlPath: string }) =>
      commands.saveCliPaths({
        helmPath: paths.helmPath || undefined,
        kubectlPath: paths.kubectlPath || undefined,
      }),
    onSuccess: async () => {
      queryClient.invalidateQueries({ queryKey: ["cli-paths"] });
      await Promise.all([checkHelmAvailability(), checkKubectlAvailability()]);
    },
    onError: (error) =>
      toast({
        title: t("settings", "toolPathsSaveFailed"),
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      }),
  });

  const browseFor = async (title: string, setter: (value: string) => void) => {
    const selected = await open({
      multiple: false,
      directory: false,
      title,
    }).catch(() => null);
    if (typeof selected === "string") setter(selected);
  };

  const tools = [
    {
      id: "kubectl",
      label: "kubectl",
      state: kubectl,
      recheck: checkKubectlAvailability,
      path: kubectlPath,
      setPath: setKubectlPath,
      note: t("settings", "kubectlPathNote"),
    },
    {
      id: "helm",
      label: "Helm",
      state: helm,
      recheck: checkHelmAvailability,
      path: helmPath,
      setPath: setHelmPath,
      note: t("settings", "helmPathNote"),
    },
  ] as const;

  /** Leaving a field is the commit; the re-check that follows is the answer. */
  const applyOn = (id: string) => (value: string) => {
    const next = {
      helmPath: id === "helm" ? value.trim() : helmPath,
      kubectlPath: id === "kubectl" ? value.trim() : kubectlPath,
    };
    if (
      next.helmPath === (cliPaths?.helmPath ?? "") &&
      next.kubectlPath === (cliPaths?.kubectlPath ?? "")
    ) {
      return;
    }
    setTyped({});
    save.mutate(next);
  };

  return (
    <div className="mt-3 border-t border-hair pt-2">
      <p className="pb-1 text-[11px] text-fg-mut">
        {t("settings", "toolPathsIntro")}
      </p>
      {tools.map((tool) => {
        const pending = isChecking || tool.state === null;
        return (
          <SettingRow
            key={tool.id}
            label={tool.label}
            htmlFor={`${tool.id}-path`}
            hint={availabilityHint(tool.state, isChecking, tool.label, t)}
            control={
              <>
                <StatusBadge
                  status={
                    pending
                      ? t("settings", "checking")
                      : tool.state?.available
                        ? t("settings", "available")
                        : t("settings", "notFound")
                  }
                  roleOverride={
                    pending ? "pending" : tool.state?.available ? "ok" : "warn"
                  }
                >
                  {pending
                    ? t("settings", "checking")
                    : tool.state?.available
                      ? t("settings", "available")
                      : t("settings", "notFound")}
                </StatusBadge>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t("settings", "recheckTool", {
                    tool: tool.label,
                  })}
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
                placeholder={t("settings", "toolPathPlaceholder", {
                  tool: tool.id,
                })}
                value={tool.path}
                onChange={(event) => tool.setPath(event.target.value)}
                onBlur={(event) => applyOn(tool.id)(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
                className="font-mono"
              />
              <Button
                variant="outline"
                size="icon"
                aria-label={t("settings", "browseForBinary", {
                  tool: tool.label,
                })}
                onClick={() =>
                  browseFor(
                    t("settings", "selectBinaryTitle", { tool: tool.label }),
                    (value) => {
                      tool.setPath(value);
                      applyOn(tool.id)(value);
                    }
                  )
                }
              >
                <FolderOpen className="h-3.5 w-3.5" />
              </Button>
            </div>
            <p className="mt-1 text-[11px] text-fg-mut">{tool.note}</p>
          </SettingRow>
        );
      })}
    </div>
  );
}
