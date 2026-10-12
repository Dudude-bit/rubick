import { lazy, Suspense, useEffect, useState } from "react";
import { TriangleAlert } from "lucide-react";
import { Sidebar } from "./Sidebar";
import { PageArea } from "./PageArea";
import { ScopeTabs } from "./ScopeTabs";
import { StatusBar } from "./StatusBar";
import { CommandPalette } from "./CommandPalette";
import { PeekPanel } from "../-peek/PeekPanel";
import { PeekHost, usePeekDock } from "../-peek/peek-dock";
import { useYamlEditorStore } from "@/stores/yamlEditorStore";
import { PageSkeleton } from "@/components/ui/skeleton";
import { useScopeTabs } from "./useScopeTabs";
import { useCopyLink } from "./useCopyLink";
import { useShortcuts } from "./useShortcuts";
import { ShortcutsOverlay } from "./ShortcutsOverlay";
import { WhatsNew } from "./WhatsNew";
import { useClusterForwards } from "@/hooks/useClusterForwards";
import { usePrefetchCoreLists } from "./usePrefetchCoreLists";
import { useRefusedScope } from "./useRefusedScope";
import { useScopeFromAddress } from "./useScopeFromAddress";
import { useCritical } from "@/hooks/useCritical";
import { useT } from "@/i18n/useT";
import { useWindowCluster } from "./useWindowCluster";
import { holdTitlesOnResize } from "@/lib/hold-titles";
import {
  useFollowedOverview,
  useScopedOverview,
} from "@/hooks/useClusterOverview";

// Loaded on first use: it carries the YAML parser and the diff view, which
// nothing needs until an object is opened for editing.
const YamlEditorDialog = lazy(() =>
  import("../-yaml/YamlEditorDialog").then((m) => ({
    default: m.YamlEditorDialog,
  }))
);

/** Mounted from the first open on, so later ones do not wait for the chunk. */
function EditorWhenOpened() {
  const open = useYamlEditorStore((state) => state.open);
  const [opened, setOpened] = useState(open);
  if (open && !opened) setOpened(true);
  if (!opened) return null;
  return (
    <Suspense fallback={null}>
      <YamlEditorDialog />
    </Suspense>
  );
}

export function Layout() {
  const t = useT();
  const { context: currentContext, color } = useWindowCluster();
  const { critical } = useCritical();
  const dock = usePeekDock();
  const [peekHost, setPeekHost] = useState<HTMLElement | null>(null);
  useScopeTabs();
  useCopyLink();
  useShortcuts();
  // Opens the tunnels this cluster asked to have up. Only the ones marked
  // for it — everything else waits to be pressed in the rail.
  useClusterForwards();
  // Warms the three lists every session opens, so their pages open from
  // cache instead of spending their first second asking.
  usePrefetchCoreLists();
  useRefusedScope();
  useScopeFromAddress();
  useFollowedOverview(useScopedOverview().data);
  useEffect(holdTitlesOnResize, []);

  return (
    <div
      className="flex h-screen flex-col overflow-hidden bg-canvas text-fg-mid"
      // The cluster's colour is a runtime value, so it rides a custom
      // property on the shell and every consumer reads `--cluster`
      // instead of being handed a colour prop.
      style={
        {
          "--cluster": color,
        } as React.CSSProperties
      }
    >
      {/* 2px along the top edge: unmissable in peripheral vision, zero
          competition with the content below it. Critical infrastructure
          gets a band with words instead: the colour alone is what the
          reader has stopped seeing by the time it matters. */}
      {critical && currentContext ? (
        <div
          data-window-cluster="accent"
          role="status"
          className="flex h-5 flex-none items-center justify-center gap-2 bg-err px-3 font-mono text-[11px] font-semibold uppercase tracking-[0.08em] text-canvas"
        >
          <TriangleAlert className="h-3 w-3" aria-hidden="true" />
          {t("cluster", "criticalStripe", { context: currentContext })}
        </div>
      ) : (
        <div
          data-window-cluster="accent"
          className="h-0.5 flex-none bg-(--cluster)"
        />
      )}
      <div className="flex flex-1 overflow-hidden">
        <Sidebar />
        <div className="flex flex-1 flex-col overflow-hidden">
          <ScopeTabs />
          <div
            ref={setPeekHost}
            className="relative flex min-h-0 flex-1 flex-col overflow-hidden"
          >
            <main
              className="flex-1 overflow-auto scrollbar-thin px-4 pb-4"
              style={dock}
            >
              {/* `h-full` is what lets a page opt out of the page scroll: a page
                that sizes itself to this box exactly fills it and this
                container never gets anything to scroll. Pages taller than it
                overflow as before. The top gap is here, not on the scroller:
                a sticky tab bar sticks below a scroller's padding, and the
                page showed through the strip above it. */}
              <div className="h-full pt-4">
                <Suspense fallback={<PageSkeleton className="p-0" />}>
                  <PageArea />
                </Suspense>
              </div>
            </main>
          </div>
          <StatusBar />
        </div>
      </div>
      <CommandPalette />
      <ShortcutsOverlay />
      <EditorWhenOpened />
      <WhatsNew />
      {/* Outside the outlet: one instance, and it survives the route change
          that `Open full page` performs. */}
      <PeekHost.Provider value={peekHost}>
        <PeekPanel />
      </PeekHost.Provider>
    </div>
  );
}
