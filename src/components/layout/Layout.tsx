import { Suspense } from "react";
import { Outlet } from "react-router-dom";
import { Sidebar } from "./Sidebar";
import { ScopeTabs } from "./ScopeTabs";
import { StatusBar } from "./StatusBar";
import { Breadcrumbs } from "./Breadcrumbs";
import { CommandPalette } from "./CommandPalette";
import { YamlEditorDialog } from "@/components/yaml";
import { PageSkeleton } from "@/components/ui/skeleton";
import { clusterColor } from "@/lib/cluster-identity";
import { useClusterStore } from "@/stores/clusterStore";

export function Layout() {
  const currentContext = useClusterStore((s) => s.currentContext);

  return (
    <div
      className="flex h-screen flex-col overflow-hidden bg-canvas text-fg-mid"
      // The cluster's colour is a runtime value, so it rides a custom
      // property on the shell and every consumer reads `--cluster`
      // instead of being handed a colour prop.
      style={
        { "--cluster": clusterColor(currentContext) } as React.CSSProperties
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
            <Breadcrumbs className="mb-4" />
            <div className="animate-in fade-in duration-200">
              <Suspense fallback={<PageSkeleton className="p-0" />}>
                <Outlet />
              </Suspense>
            </div>
          </main>
          <StatusBar />
        </div>
      </div>
      <CommandPalette />
      <YamlEditorDialog />
    </div>
  );
}
