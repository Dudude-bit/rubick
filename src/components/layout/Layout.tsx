import { Suspense } from "react";
import { Outlet } from "react-router-dom";
import { Sidebar } from "./Sidebar";
import { Header } from "./Header";
import { Breadcrumbs } from "./Breadcrumbs";
import { CommandPalette } from "./CommandPalette";
import { YamlEditorDialog } from "@/components/yaml";
import { PageSkeleton } from "@/components/ui/skeleton";

export function Layout() {
  return (
    <div className="flex h-screen overflow-hidden bg-canvas text-fg-mid">
      <Sidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <Header />
        <main className="flex-1 overflow-auto scrollbar-thin p-4">
          <Breadcrumbs className="mb-4" />
          <div className="animate-in fade-in duration-200">
            <Suspense fallback={<PageSkeleton className="p-0" />}>
              <Outlet />
            </Suspense>
          </div>
        </main>
      </div>
      <CommandPalette />
      <YamlEditorDialog />
    </div>
  );
}
