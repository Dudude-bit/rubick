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
  // Integrations moved out to its own door before Settings became a layer, and
  // `/settings/integrations` kept working for every link and bookmark that
  // predates that move. It is not a section name, so opening the layer with it
  // falls back to the default one — the wrong screen and the wrong pane for a
  // tab an older build persisted at this address.
  const toCatalog = section === "integrations";

  useEffect(() => {
    if (toCatalog) return;
    openSettings(section || undefined);
  }, [toCatalog, section, openSettings]);

  return <Navigate to={toCatalog ? "/integrations" : "/"} replace />;
}
