import type { ReactNode } from "react";

/**
 * The frame for an address naming no cluster this app can open: no sidebar,
 * tabs or status bar, since each of those belongs to the cluster that is
 * connected, and a click in them lands on a cluster the address does not name.
 */
export function ClusterlessShell({ page }: { page: ReactNode }) {
  return (
    <div className="flex h-screen flex-col overflow-hidden bg-canvas text-fg-mid">
      <main className="flex-1 overflow-auto scrollbar-lane [scrollbar-gutter:stable] py-4 pl-4 pr-2">
        {page}
      </main>
    </div>
  );
}
