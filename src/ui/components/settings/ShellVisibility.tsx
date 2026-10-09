import type { ReactNode } from "react";

import { SurfaceVisibility } from "@/lib/surface-visibility";
import { useSettingsStore } from "@/stores/settingsStore";

/**
 * Whether the routed shell is the thing the reader can see.
 *
 * Settings used to be a route, and a route swap unmounted the page it
 * replaced. It is a layer now — an opaque one, over the whole window — and a
 * sibling of `<Routes>` rather than one of them, so the page underneath stayed
 * mounted and went on asking the cluster questions nobody could see the
 * answers to.
 *
 * `SurfaceVisibility` is the mechanism this app already has for a subtree that
 * is mounted and off screen; this is the one decision that drives it, named so
 * it can be tested without standing up the whole application.
 */
export function ShellVisibility({ children }: { children: ReactNode }) {
  const settingsOpen = useSettingsStore((state) => state.open);
  return (
    <SurfaceVisibility.Provider value={!settingsOpen}>
      {children}
    </SurfaceVisibility.Provider>
  );
}
