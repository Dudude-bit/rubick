/**
 * The tab strip, and the panels under it — the strip and nothing else, since
 * the header, the breadcrumb and the actions belong to the page.
 *
 * Shared with screens that are not resource detail pages: the two rules a tab
 * is drawn by — `detail-tab.ts`'s glyph and its earned mark — are worth
 * exactly as much on an integration's page as on a Deployment's, and a second
 * strip beside this one would drift from it by the second vendor.
 */

import { useState } from "react";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CaptionScope } from "@/components/ui/section";
import { SurfaceVisibility, useSurfaceVisible } from "@/lib/surface-visibility";
import { TabGlyph, TabMark } from "./tab-marks";
import { surfaceIsOpen, type DetailTab } from "./detail-tab";

/** One tab, drawn by the two rules rather than by its label. */
function DetailTabTrigger({
  tab,
  isActive,
}: {
  tab: DetailTab;
  isActive: boolean;
}) {
  const says =
    tab.mark && tab.mark.shows !== "count"
      ? `${tab.label} — ${tab.mark.says}`
      : null;

  return (
    <TabsTrigger
      value={tab.id}
      title={
        says ??
        (tab.mark?.shows === "count"
          ? `${tab.label} — ${tab.mark.of}`
          : undefined)
      }
      aria-label={says ?? undefined}
      className="group -mb-px h-8 min-w-0 justify-start gap-1.5 rounded-none border-b border-transparent px-0.5 text-xs font-normal text-fg-mut shadow-none transition-colors hover:bg-transparent hover:text-fg data-[state=active]:border-fg data-[state=active]:bg-transparent data-[state=active]:font-medium data-[state=active]:text-fg data-[state=active]:shadow-none"
    >
      {/* `flex-none` on both the glyph and the mark, `truncate` only on the
          label: a tab that gave up its glyph to fit would lose the half of
          itself that can be read without reading. */}
      <TabGlyph glyph={tab.glyph} isActive={isActive} />
      <span className="truncate">{tab.label}</span>
      {tab.mark && <TabMark mark={tab.mark} isActive={isActive} />}
    </TabsTrigger>
  );
}

/**
 * Which tabs have been opened at least once.
 *
 * Radix unmounts the panel of every tab that is not the open one, which is
 * right for a stack of blocks and wrong for a surface: a surface holds
 * something live — an attached shell, a log stream, an editor's undo history
 * — and unmounting it is not hiding it, it is ending it. So a surface panel
 * stays mounted once it has been *opened*, and not before: force-mounting
 * every surface on arrival would open an exec session into a pod nobody asked
 * to shell into, and start a log stream for a reader who came for the
 * Overview.
 *
 * Grown in render rather than in an effect: by the time this render runs the
 * tab is already the active one, and its panel has to be in this pass's
 * output. Adding a member schedules nothing and is idempotent, so a double
 * render arrives at the same set.
 */
function useOpenedTabs(activeTab: string): ReadonlySet<string> {
  const [opened] = useState<Set<string>>(() => new Set());
  opened.add(activeTab);
  return opened;
}

export function DetailTabs({
  tabs,
  activeTab,
  onTabChange,
  actions,
}: {
  tabs: DetailTab[];
  activeTab: string;
  onTabChange: (tab: string) => void;
  /** Controls belonging to the page, pinned to the right of the same row. */
  actions?: React.ReactNode;
}) {
  const opened = useOpenedTabs(activeTab);
  const surface = surfaceIsOpen(tabs, activeTab);
  // Force-mounting a surface keeps its shell attached and its log stream
  // running, which is the point. It must not also keep its queries re-reading
  // the cluster for a panel nobody can see, and since the panel is mounted
  // nothing downstream can work that out for itself.
  const pageVisible = useSurfaceVisible();

  return (
    <Tabs
      value={activeTab}
      onValueChange={onTabChange}
      className={surface ? "flex min-h-0 flex-1 flex-col" : undefined}
    >
      {/* One control row rather than two, an underline rather than a pill row:
          the window already has a pill tab strip for scopes, and two of them
          on one screen read as the same control at two levels. The page's
          actions share the row's hairline so it reads as one band, held off
          by a pip — a control flush against a tab strip reads as another
          destination, and "Delete" must never be mistaken for a place to
          go. */}
      <div className="flex flex-none items-stretch gap-3">
        <TabsList className="h-auto min-w-0 flex-1 justify-start gap-4 rounded-none border-b border-hair bg-transparent p-0 text-fg-mut">
          {tabs.map((tab) => (
            <DetailTabTrigger
              key={tab.id}
              tab={tab}
              isActive={tab.id === activeTab}
            />
          ))}
        </TabsList>
        {actions && (
          <div className="flex flex-none items-center gap-1 border-b border-hair">
            <span
              aria-hidden="true"
              className="mr-2 h-3.5 w-px flex-none bg-hair"
            />
            {actions}
          </div>
        )}
      </div>

      {tabs.map((tab) => (
        <TabsContent
          key={tab.id}
          value={tab.id}
          // `data-[state=inactive]:hidden` on the shared panel is what
          // takes a force-mounted one off the screen: Radix only sets the
          // `hidden` attribute for panels it would have unmounted.
          forceMount={
            tab.kind === "surface" && opened.has(tab.id) ? true : undefined
          }
          className={
            tab.kind === "surface"
              ? // A floor rather than `min-h-0`: below it the window is too
                // short for the pane to be worth anything, and letting the
                // page scroll again is better than a two-row log.
                "mt-0 min-h-[240px] flex-1 overflow-hidden"
              : "mt-[18px] flex flex-col gap-[22px]"
          }
        >
          <SurfaceVisibility.Provider
            value={pageVisible && tab.id === activeTab}
          >
            {/* The strip has just said this word; whatever the tab opens
                with does not have to say it again. */}
            <CaptionScope tab={tab.label}>{tab.content}</CaptionScope>
          </SurfaceVisibility.Provider>
        </TabsContent>
      ))}
    </Tabs>
  );
}
