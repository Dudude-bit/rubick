/**
 * Auto Updater Hook
 *
 * Handles automatic update checks on app startup and at regular intervals.
 * Shows toast notifications when updates are available.
 *
 * @module hooks/useAutoUpdater
 */

import { useT } from "@/i18n/useT";
import { useEffect, useRef } from "react";
import { useUpdaterStore } from "@/stores/updaterStore";
import { toast } from "@/components/ui/use-toast";

/** Update check interval in milliseconds (30 minutes) */
const UPDATE_CHECK_INTERVAL = 30 * 60 * 1000;

/**
 * Hook for automatic update checking
 *
 * Should be called once at app root level (e.g., in App.tsx).
 * Manages initial update check and periodic checks based on user settings.
 *
 * @example
 * ```tsx
 * function App() {
 *   useAutoUpdater();
 *   return <Routes>...</Routes>;
 * }
 * ```
 */
export function useAutoUpdater() {
  const t = useT();
  const {
    autoCheckEnabled,
    settingsLoaded,
    canInstall,
    available,
    loadSettings,
    checkForUpdates,
  } = useUpdaterStore();

  const hasShownToast = useRef(false);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  // Load settings on mount
  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  // Initial check and periodic checks
  useEffect(() => {
    if (!settingsLoaded) return;
    // Only a definite no stops the checks: the Flatpak bundle would download
    // 100 MB every half hour and fail to install it. Unknown is not that no.
    if (canInstall === false) return;

    const performCheck = async () => {
      if (!autoCheckEnabled) return;

      const update = await checkForUpdates();
      if (update && !hasShownToast.current) {
        hasShownToast.current = true;
        toast({
          title: t("settings", "updateAvailableTitle"),
          description: t("settings", "updateAvailableToast", {
            version: update.version,
          }),
        });
      }
    };

    // Initial check (with small delay to let app load)
    const initialTimeout = setTimeout(performCheck, 2000);

    // Set up periodic checks
    if (autoCheckEnabled) {
      intervalRef.current = setInterval(performCheck, UPDATE_CHECK_INTERVAL);
    }

    return () => {
      clearTimeout(initialTimeout);
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [settingsLoaded, autoCheckEnabled, canInstall, checkForUpdates, t]);

  // Reset toast flag when update is dismissed
  useEffect(() => {
    if (!available) {
      hasShownToast.current = false;
    }
  }, [available]);
}
