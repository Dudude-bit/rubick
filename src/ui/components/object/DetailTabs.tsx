/**
 * The tab strip, and the panels under it — the strip and nothing else, since
 * the header, the breadcrumb and the actions belong to the page.
 *
 * Shared with screens that are not resource detail pages: the two rules a tab
 * is drawn by — `detail-tab.ts`'s glyph and its earned mark — are worth
 * exactly as much on an integration's page as on a Deployment's, and a second
 * strip beside this one would drift from it by the second vendor.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useT } from "@/i18n/useT";
import { cn } from "@/lib/utils";
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
      ? `${tab.label}: ${tab.mark.says}`
      : null;

  return (
    <TabsTrigger
      value={tab.id}
      data-tab={tab.id}
      title={
        says ??
        (tab.mark?.shows === "count"
          ? `${tab.label}: ${tab.mark.of}`
          : undefined)
      }
      aria-label={says ?? undefined}
      className="group -mb-px h-8 shrink-0 justify-start gap-1.5 whitespace-nowrap rounded-none border-b border-transparent px-0.5 text-xs font-normal text-fg-mut shadow-none transition-colors hover:bg-transparent hover:text-fg data-[state=active]:border-fg data-[state=active]:bg-transparent data-[state=active]:font-medium data-[state=active]:text-fg data-[state=active]:shadow-none"
    >
      {/* A one-letter tab is unreadable, so nothing here shrinks or
          truncates; the strip scrolls instead. */}
      <TabGlyph glyph={tab.glyph} isActive={isActive} />
      <span className="whitespace-nowrap">{tab.label}</span>
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

/** The tabs the strip has scrolled out of sight, and on which side. */
interface Clipped {
  ids: string[];
  before: boolean;
  after: boolean;
}

const NOTHING_CLIPPED: Clipped = { ids: [], before: false, after: false };

function useClippedTabs(
  strip: React.RefObject<HTMLDivElement | null>,
  ids: string
): Clipped {
  const [clipped, setClipped] = useState(NOTHING_CLIPPED);
  useLayoutEffect(() => {
    const list = strip.current;
    if (!list) return;
    const measure = () => {
      const box = list.getBoundingClientRect();
      const next: Clipped = { ids: [], before: false, after: false };
      for (const tab of list.querySelectorAll<HTMLElement>("[data-tab]")) {
        const edge = tab.getBoundingClientRect();
        const before = edge.left < box.left - 1;
        const after = edge.right > box.right + 1;
        if (!before && !after) continue;
        next.ids.push(tab.dataset.tab ?? "");
        next.before ||= before;
        next.after ||= after;
      }
      setClipped((prev) =>
        prev.ids.join("\n") === next.ids.join("\n") &&
        prev.before === next.before &&
        prev.after === next.after
          ? prev
          : next
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    for (const tab of list.querySelectorAll("[data-tab]"))
      observer.observe(tab);
    list.addEventListener("scroll", measure, { passive: true });
    return () => {
      observer.disconnect();
      list.removeEventListener("scroll", measure);
    };
  }, [strip, ids]);
  return clipped;
}

/** Every tab the strip cannot show, one click away and named. */
function HiddenTabs({
  tabs,
  onPick,
}: {
  tabs: DetailTab[];
  onPick: (tab: string) => void;
}) {
  const t = useT();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t("action", "tabsMoreLabel", { n: tabs.length })}
          className="flex flex-none items-center gap-1 border-b border-hair pl-2 text-xs text-fg-mut transition-colors hover:text-fg focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-info"
        >
          {t("action", "tabsMore", { n: tabs.length })}
          <ChevronDown className="h-3 w-3" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {tabs.map((tab) => (
          <DropdownMenuItem
            key={tab.id}
            onSelect={() => onPick(tab.id)}
            className="gap-1.5"
          >
            <TabGlyph glyph={tab.glyph} isActive={false} />
            {tab.label}
            {tab.mark && <TabMark mark={tab.mark} isActive={false} />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Fades the side the strip continues on, so a cut tab reads as more to come. */
const FADE = {
  before: "[mask-image:linear-gradient(to_right,transparent,black_2rem)]",
  after:
    "[mask-image:linear-gradient(to_right,black_calc(100%-2rem),transparent)]",
  both: "[mask-image:linear-gradient(to_right,transparent,black_2rem,black_calc(100%-2rem),transparent)]",
} as const;

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
  // A tab named by a link that this page does not have opens the first one
  // rather than none: a page with every panel hidden reads as broken.
  const requested = tabs.some((tab) => tab.id === activeTab);
  const current = requested || tabs.length === 0 ? activeTab : tabs[0].id;
  const opened = useOpenedTabs(current);
  const surface = surfaceIsOpen(tabs, current);
  // Force-mounting a surface keeps its shell attached and its log stream
  // running, which is the point. It must not also keep its queries re-reading
  // the cluster for a panel nobody can see, and since the panel is mounted
  // nothing downstream can work that out for itself.
  const pageVisible = useSurfaceVisible();
  const stripRef = useRef<HTMLDivElement>(null);
  const clipped = useClippedTabs(
    stripRef,
    tabs.map((tab) => tab.id).join("\n")
  );
  const fade =
    clipped.before && clipped.after
      ? FADE.both
      : clipped.before
        ? FADE.before
        : clipped.after
          ? FADE.after
          : undefined;

  useEffect(() => {
    stripRef.current
      ?.querySelector<HTMLElement>('[data-state="active"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [current]);

  return (
    <Tabs
      value={current}
      onValueChange={onTabChange}
      className={surface ? "flex min-h-0 flex-1 flex-col" : undefined}
    >
      {/* One control row rather than two, an underline rather than a pill row:
          the window already has a pill tab strip for scopes, and two of them
          on one screen read as the same control at two levels. The page's
          actions share the row's hairline so it reads as one band, held off
          by a pip — a control flush against a tab strip reads as another
          destination, and "Delete" must never be mistaken for a place to
          go. Tabs never shrink: when the actions do not fit they wrap to
          their own row, and only tabs wider than the page scroll. */}
      <div className="flex flex-wrap items-stretch gap-3">
        <div className="flex min-w-0 flex-auto items-stretch">
          <TabsList
            ref={stripRef}
            onWheel={(event) => {
              const el = event.currentTarget;
              if (el.scrollWidth <= el.clientWidth) return;
              el.scrollLeft += event.deltaY || event.deltaX;
            }}
            className={cn(
              "h-auto min-w-0 flex-1 justify-start gap-4 overflow-x-auto rounded-none border-b border-hair bg-transparent p-0 text-fg-mut scrollbar-thin",
              fade
            )}
          >
            {tabs.map((tab) => (
              <DetailTabTrigger
                key={tab.id}
                tab={tab}
                isActive={tab.id === current}
              />
            ))}
          </TabsList>
          {clipped.ids.length > 0 && (
            <HiddenTabs
              tabs={tabs.filter((tab) => clipped.ids.includes(tab.id))}
              onPick={onTabChange}
            />
          )}
        </div>
        {actions && (
          <div className="ml-auto flex flex-none items-center gap-1 border-b border-hair">
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
          <SurfaceVisibility.Provider value={pageVisible && tab.id === current}>
            {/* The strip has just said this word; whatever the tab opens
                with does not have to say it again. */}
            <CaptionScope tab={tab.label}>{tab.content}</CaptionScope>
          </SurfaceVisibility.Provider>
        </TabsContent>
      ))}
    </Tabs>
  );
}
