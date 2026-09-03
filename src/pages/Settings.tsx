import { useEffect } from "react";
import { Navigate, useParams } from "react-router-dom";

import { useSettingsStore } from "@/stores/settingsStore";

/**
 * The address Settings used to have.
 *
 * Settings is a layer over the window now, not a page, but a tab persisted
 * by an older build can still point here, and so can a link written before
 * the move. The section in the address opens; the tab itself goes home,
 * which is where a tab with no page belongs.
 */
export function SettingsRedirect() {
  const { "*": splat = "" } = useParams();
  const openSettings = useSettingsStore((state) => state.openSettings);
  const section = splat.split("/")[0] ?? "";

  useEffect(() => {
    openSettings(section || undefined);
  }, [section, openSettings]);

  return <Navigate to="/" replace />;
}
