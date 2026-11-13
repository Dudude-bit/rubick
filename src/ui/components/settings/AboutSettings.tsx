import { AlertCircle, Download, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { ReadAgain } from "@/components/ui/read-again";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/use-toast";
import { toastError } from "@/lib/toast-error";
import { OutLink } from "@/components/ui/out-link";
import { useAppInfo } from "@/hooks/useAppInfo";
import { RUBICK_DOCS } from "@/lib/docs";
import { useUpdaterStore } from "@/stores/updaterStore";
import { useWhatsNewStore } from "@/stores/whatsNewStore";
import { SettingRow, SettingsGroup } from "./settings-row";
import { useT } from "@/i18n/useT";
import { formatWhen } from "@/lib/utils";
import type { en } from "@/i18n/catalogue";

type UpdateLine = "checking" | "failed" | "upToDate" | "notChecked";

/** "Latest" only from a check that reached the release feed and found nothing newer. */
const UPDATE_LINE: Record<UpdateLine, keyof typeof en.settings> = {
  checking: "checkingUpdates",
  failed: "updateCheckFailed",
  upToDate: "upToDate",
  notChecked: "updatesNotChecked",
};

const updateLine = ({
  checking,
  error,
  checkedAt,
}: {
  checking: boolean;
  error?: string;
  checkedAt: number | null;
}): UpdateLine =>
  checking
    ? "checking"
    : error
      ? "failed"
      : checkedAt !== null
        ? "upToDate"
        : "notChecked";

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
    checkedAt,
    downloading,
    progress,
    error,
    autoCheckEnabled,
    canInstall,
    setAutoCheckEnabled,
    checkForUpdates,
    downloadAndInstall,
  } = useUpdaterStore();

  const appInfoQuery = useAppInfo();
  const appInfo = appInfoQuery.data;
  const appInfoValue = (
    value: string | undefined,
    retry: boolean
  ): ReactNode =>
    appInfoQuery.isPending ? (
      <Spinner
        size="xs"
        role="status"
        aria-label={t("action", "reading")}
        className="text-fg-fnt"
      />
    ) : appInfoQuery.isError ? (
      retry ? (
        <ReadAgain
          error={appInfoQuery.error}
          onRetry={() => appInfoQuery.refetch()}
        />
      ) : (
        <span className="text-caption text-fg-fnt">
          {t("settings", "notRead")}
        </span>
      )
    ) : (
      value
    );

  return (
    <div className="flex flex-col gap-5">
      <SettingsGroup>
        <SettingRow
          label={t("settings", "version")}
          keywords={t("settings", "searchVersionWords")}
          control={
            <span className="font-mono text-xs text-fg">
              {appInfoValue(appInfo?.version, true)}
            </span>
          }
        />
        <SettingRow
          label={t("settings", "whatsNew")}
          hint={t("settings", "whatsNewHint")}
          keywords={t("settings", "searchWhatsNewWords")}
          control={
            <Button
              variant="outline"
              size="sm"
              disabled={!appInfo}
              onClick={() =>
                appInfo && useWhatsNewStore.getState().show([appInfo.version])
              }
            >
              {t("settings", "showWhatsNew")}
            </Button>
          }
        />
        <SettingRow
          label={t("settings", "documentation")}
          hint={t("settings", "documentationHint")}
          keywords={t("settings", "searchDocsWords")}
          control={
            <OutLink href={RUBICK_DOCS} site="GitHub" className="text-xs">
              {t("settings", "openReadme")}
            </OutLink>
          }
        />
        <SettingRow
          label="Tauri"
          keywords={t("settings", "searchRuntimeWords")}
          control={
            <span className="font-mono text-xs text-fg-mut">
              {appInfoValue(appInfo?.tauriVersion, false)}
            </span>
          }
        />
        <SettingRow
          label={t("settings", "framework")}
          keywords={t("settings", "searchFrameworkWords")}
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
              : t(
                  "settings",
                  UPDATE_LINE[updateLine({ checking, error, checkedAt })]
                )
          }
          hint={
            checkedAt === null
              ? t("settings", "updateHint")
              : `${t("settings", "lastChecked", { time: formatWhen(checkedAt, "clock") })} ${t("settings", "updateHint")}`
          }
          keywords={t("settings", "searchUpdateWords")}
          control={
            canInstall === false ? (
              // No button where pressing it can only end in a failed install.
              <span className="text-caption text-fg-mut">
                {t("settings", "managedUpdates")}
              </span>
            ) : available ? (
              <Button
                size="sm"
                pending={downloading}
                onClick={() =>
                  void downloadAndInstall().catch((failure) =>
                    toastError(t("settings", "installationFailed"), failure)
                  )
                }
              >
                <Download className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                {downloading
                  ? t("settings", "downloadingUpdate")
                  : t("settings", "downloadAndInstall")}
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
                  } else if (!useUpdaterStore.getState().error) {
                    toast({
                      title: t("settings", "noUpdates"),
                      description: t("settings", "upToDateToast"),
                    });
                  }
                }}
                pending={checking}
                disabled={downloading}
              >
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
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
              <span className="font-mono text-caption text-fg-mut">
                {progress}%
              </span>
              <span className="text-caption text-fg-fnt">
                {t("settings", "downloadingUpdateHint")}
              </span>
            </div>
          )}
          {error && (
            <p className="flex items-center gap-1.5 text-caption text-err">
              <AlertCircle className="h-3 w-3 flex-none" aria-hidden="true" />
              {error}
            </p>
          )}
        </SettingRow>
        {canInstall !== false && (
          <SettingRow
            label={t("settings", "autoUpdates")}
            hint={t("settings", "autoUpdatesHint")}
            keywords={t("settings", "searchAutoUpdateWords")}
            control={
              <Switch
                aria-label={t("settings", "autoUpdates")}
                checked={autoCheckEnabled}
                onCheckedChange={setAutoCheckEnabled}
              />
            }
          />
        )}
      </SettingsGroup>
    </div>
  );
}
