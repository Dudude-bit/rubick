import { Suspense } from "react";
import { Outlet } from "react-router-dom";
import { Sidebar } from "./Sidebar";
import { CredentialsExpired } from "@/components/cluster/CredentialsExpired";
import { useExpiredCredentials } from "@/hooks/useExpiredCredentials";
import { ScopeTabs } from "./ScopeTabs";
import { StatusBar } from "./StatusBar";
import { CommandPalette } from "./CommandPalette";
import { PeekPanel } from "@/components/resources/PeekPanel";
import { YamlEditorDialog } from "@/components/yaml";
import { PageSkeleton } from "@/components/ui/skeleton";
import { clusterColor } from "@/lib/cluster-identity";
import { useScopeTabs } from "@/hooks/useScopeTabs";
import { useClusterMark } from "@/stores/clusterIdentityStore";
import { useClusterStore } from "@/stores/clusterStore";
import { useScopeTabStore } from "@/stores/scopeTabStore";

export function Layout() {
  const currentContext = useClusterStore((s) => s.currentContext);
  const { hue } = useClusterMark(currentContext);
  const expired = useExpiredCredentials();
  const catchingUp = useScopeTabStore((s) => s.pendingHref !== null);
  useScopeTabs();

  return (
    <div
      className="flex h-screen flex-col overflow-hidden bg-canvas text-fg-mid"
      // The cluster's colour is a runtime value, so it rides a custom
      // property on the shell and every consumer reads `--cluster`
      // instead of being handed a colour prop.
      style={
        {
          "--cluster": clusterColor(currentContext, hue),
        } as React.CSSProperties
      }
    >
      {/* 2px along the top edge: unmissable in peripheral vision, zero
          competition with the content below it. */}
      <div className="h-0.5 flex-none bg-[var(--cluster)]" />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar />
        <div className="flex flex-1 flex-col overflow-hidden">
          <ScopeTabs />
          <main className="flex-1 overflow-auto scrollbar-thin p-4">
            {/* `h-full` is what lets a page opt out of the page scroll: a page
                that sizes itself to this box exactly fills it and this
                container never gets anything to scroll. Pages taller than it
                overflow as before. */}
            <div className="h-full animate-in fade-in duration-200">
              <Suspense fallback={<PageSkeleton className="p-0" />}>
                {/* A tab that has been parked has no watches and no
                    connection, so what is cached under it was true minutes
                    ago. Holding the outlet shut until the tab's route has
                    landed and its scope is applied is what stops the reader
                    being handed those numbers as though they were live. */}
                {/* A refused session replaces the page rather than warning
                    over it: nothing behind this is answerable, and every list
                    under it would draw its empty state — which is how an
                    expired token came to tell the reader their cluster had no
                    pods. */}
                {expired ? (
                  <CredentialsExpired expired={expired} />
                ) : catchingUp ? (
                  <PageSkeleton className="p-0" />
                ) : (
                  <Outlet />
                )}
              </Suspense>
            </div>
          </main>
          <StatusBar />
        </div>
      </div>
      <CommandPalette />
      <YamlEditorDialog />
      {/* Outside the outlet: one instance, and it survives the route change
          that `Open full page` performs. */}
      <PeekPanel />
    </div>
  );
}
