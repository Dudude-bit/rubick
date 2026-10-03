import { AlertTriangle, RefreshCw } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { cn } from "@/lib/utils";
import { useDependenciesStore } from "@/stores/dependenciesStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useT } from "@/i18n/useT";

interface HelmStatusBannerProps {
  className?: string;
  /** One line instead of the full list of what is disabled. */
  minimal?: boolean;
}

/**
 * Missing Helm CLI is a degraded state, not a failure: releases still read
 * fine over the Kubernetes API, only the write operations are gone. It is a
 * notice on the canvas, in the warning colour with the word beside it.
 */
export function HelmStatusBanner({
  className,
  minimal = false,
}: HelmStatusBannerProps) {
  const t = useT();
  const openSettings = useSettingsStore((state) => state.openSettings);
  const { helm, isChecking, checkHelmAvailability } = useDependenciesStore();

  if (!helm || helm.available) {
    return null;
  }

  if (minimal) {
    return (
      <p className={cn("flex items-center gap-1.5 text-[11px]", className)}>
        <AlertTriangle className="h-3.5 w-3.5 text-warn" aria-hidden="true" />
        <span className="text-warn">{t("empty", "helmCliNotFound")}.</span>
        <button
          type="button"
          onClick={() => openSettings("clusters")}
          className="text-info hover:underline"
        >
          {t("action", "configureInSettings")}
        </button>
      </p>
    );
  }

  return (
    <Alert className={cn("border-warn text-warn", className)}>
      <AlertTriangle className="text-warn" />
      <AlertTitle className="flex items-center gap-2">
        {t("empty", "helmCliNotFound")}
        <button
          type="button"
          onClick={() => checkHelmAvailability()}
          disabled={isChecking}
          aria-label={t("action", "checkAgain")}
          className="rounded p-0.5 text-fg-fnt transition-colors hover:bg-hover hover:text-fg disabled:pointer-events-none disabled:opacity-40"
        >
          <RefreshCw className={cn("h-3 w-3", isChecking && "animate-spin")} />
        </button>
      </AlertTitle>
      <AlertDescription className="flex flex-col gap-1 text-fg-mut">
        <p>{t("empty", "helmWriteOpsNeedCli")}</p>
        {helm.error && <p className="text-fg-fnt">{helm.error}</p>}
        <p className="flex items-center gap-3 pt-0.5">
          <button
            type="button"
            onClick={() => openSettings("clusters")}
            className="text-info hover:underline"
          >
            {t("action", "configureInSettings")}
          </button>
          <a
            href="https://helm.sh/docs/intro/install/"
            target="_blank"
            rel="noopener noreferrer"
            className="text-info hover:underline"
          >
            {t("action", "installHelm")}
          </a>
        </p>
      </AlertDescription>
    </Alert>
  );
}
