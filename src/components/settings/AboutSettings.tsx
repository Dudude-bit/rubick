import { useQuery } from "@tanstack/react-query";
import { AlertCircle, Download, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/use-toast";
import { commands } from "@/lib/commands";
import { useUpdaterStore } from "@/stores/updaterStore";
import { SettingRow, SettingsGroup } from "./settings-row";
import { useT } from "@/i18n/useT";

/**
 * What this build is, and — separately — replacing it.
 *
 * The two used to share one group, which put a button that downloads and
 * restarts the app in a list of read-only facts, and left its progress bar
 * and its failure squeezed into a row sized for a version string. Checking
 * for an update is a task: it gets its own caption, its own progress, and
 * its own error line.
 */
export function AboutSettings() {
  const t = useT();
  const { toast } = useToast();
  const {
    available,
    version,
    checking,
    downloading,
    progress,
    error,
    autoCheckEnabled,
    setAutoCheckEnabled,
    checkForUpdates,
    downloadAndInstall,
  } = useUpdaterStore();

  const { data: appInfo } = useQuery({
    queryKey: ["appInfo"],
    queryFn: commands.getAppInfo,
    staleTime: Infinity,
  });

  return (
    <div className="flex flex-col gap-5">
      <SettingsGroup>
        <SettingRow
          label={t("settings", "version")}
          keywords="build release"
          control={
            <span className="font-mono text-xs text-fg">
              {appInfo?.version ?? "…"}
            </span>
          }
        />
        <SettingRow
          label="Tauri"
          keywords="runtime webview"
          control={
            <span className="font-mono text-xs text-fg-mut">
              {appInfo?.tauriVersion ?? "…"}
            </span>
          }
        />
        <SettingRow
          label={t("settings", "framework")}
          keywords="react typescript"
          control={
            <span className="text-xs text-fg-mut">React + TypeScript</span>
          }
        />
      </SettingsGroup>

      <SettingsGroup title={t("settings", "updates")}>
        <SettingRow
          label={
            available && version
              ? t("settings", "updateAvailable", { version })
              : t("settings", "upToDate")
          }
          hint={t("settings", "updateHint")}
          keywords="update upgrade install download"
          control={
            available && !downloading ? (
              <Button
                size="sm"
                onClick={() => {
                  toast({
                    title: t("settings", "downloadingUpdate"),
                    description: t("settings", "downloadingUpdateHint"),
                  });
                  downloadAndInstall();
                }}
              >
                <Download className="mr-1.5 h-3 w-3" aria-hidden="true" />
                {t("settings", "downloadAndInstall")}
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={async () => {
                  const update = await checkForUpdates();
                  if (update) {
                    toast({
                      title: t("settings", "updateFound"),
                      description: t("settings", "updateReady", {
                        version: update.version,
                      }),
                    });
                  } else if (!error) {
                    toast({
                      title: t("settings", "noUpdates"),
                      description: t("settings", "upToDateToast"),
                    });
                  }
                }}
                disabled={checking || downloading}
              >
                <RefreshCw
                  className={`mr-1.5 h-3 w-3 ${checking ? "animate-spin" : ""}`}
                  aria-hidden="true"
                />
                {checking
                  ? t("settings", "checkingUpdates")
                  : t("settings", "checkForUpdates")}
              </Button>
            )
          }
        >
          {downloading && (
            <div className="flex items-center gap-2">
              <Progress value={progress} className="max-w-xs" />
              <span className="font-mono text-[11px] text-fg-mut">
                {progress}%
              </span>
            </div>
          )}
          {error && (
            <p className="flex items-center gap-1.5 text-[11px] text-err">
              <AlertCircle className="h-3 w-3 flex-none" aria-hidden="true" />
              {error}
            </p>
          )}
        </SettingRow>
        <SettingRow
          label={t("settings", "autoUpdates")}
          hint={t("settings", "autoUpdatesHint")}
          keywords="auto check background"
          control={
            <Switch
              aria-label={t("settings", "autoUpdates")}
              checked={autoCheckEnabled}
              onCheckedChange={setAutoCheckEnabled}
            />
          }
        />
      </SettingsGroup>
    </div>
  );
}
