/**
 * The tab strip, and the panels under it — the strip and nothing else, since
 * the header, the breadcrumb and the actions belong to the page.
 *
 * Shared with screens that are not resource detail pages: the two rules a tab
 * is drawn by — `detail-tab.ts`'s glyph and its earned mark — are worth
 * exactly as much on an integration's page as on a Deployment's, and a second
 * strip beside this one would drift from it by the second vendor.
 */

import { useLayoutEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";

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
import { fitTabs } from "./tab-fit";

const STEP: Record<string, (at: number, count: number) => number> = {
  ArrowLeft: (at, count) => (at - 1 + count) % count,
  ArrowRight: (at, count) => (at + 1) % count,
  Home: () => 0,
  End: (_, count) => count - 1,
  PageUp: () => 0,
  PageDown: (_, count) => count - 1,
};

/** Radix's arrow walk, with a focus that scrolls nothing: its own moved the page around the strip. */
function stepFocus(event: React.KeyboardEvent<HTMLElement>) {
  const step = STEP[event.key];
  if (!step || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey)
    return;
  const list = event.currentTarget.closest('[role="tablist"]');
  const tabs = [
    ...(list?.querySelectorAll<HTMLElement>(
      '[role="tab"]:not([data-overflow])'
    ) ?? []),
  ];
  const at = tabs.indexOf(event.currentTarget);
  if (at < 0) return;
  event.preventDefault();
  tabs[step(at, tabs.length)].focus({ preventScroll: true });
}

/** One tab, drawn by the two rules rather than by its label. */
function DetailTabTrigger({
  tab,
  isActive,
  isStop,
  ring,
  overflow,
  onAgain,
}: {
  tab: DetailTab;
  isActive: boolean;
  /** The strip's only Tab stop; Radix's own misses Shift+Tab, which WebKitGTK names "Unidentified". */
  isStop: boolean;
  /** WebKit gives a focus a click began no :focus-visible, the arrows' included. */
  ring: boolean;
  /** In the menu, not the strip: kept out of sight and out of the way, still measured. */
  overflow: boolean;
  onAgain?: (tab: string) => void;
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
      onKeyDown={stepFocus}
      onClick={isActive && onAgain ? () => onAgain(tab.id) : undefined}
      tabIndex={isStop && !overflow ? 0 : -1}
      data-ring={ring ? "true" : undefined}
      data-overflow={overflow ? "true" : undefined}
      className="group -mb-px h-8 shrink-0 data-[overflow=true]:invisible data-[overflow=true]:absolute justify-start gap-1.5 whitespace-nowrap rounded-none border-b border-transparent px-0.5 text-xs font-normal text-fg-mut shadow-none transition-colors hover:bg-transparent hover:text-fg focus-visible:ring-inset *:pointer-events-none data-[ring=true]:ring-1 data-[ring=true]:ring-inset data-[ring=true]:ring-info data-[state=active]:border-fg data-[state=active]:bg-transparent data-[state=active]:font-medium data-[state=active]:text-fg data-[state=active]:shadow-none"
    >
      {/* A one-letter tab is unreadable, so nothing here shrinks or
          truncates; a tab that does not fit goes to the menu whole. */}
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
 *
 * Kept per `subject`: a page stays mounted when it moves to another object,
 * and a shell opened on the last pod would otherwise open on the next one.
 */
function useOpenedTabs(
  activeTab: string,
  subject: string
): ReadonlySet<string> {
  const [opened, setOpened] = useState(() => ({
    subject,
    tabs: new Set<string>(),
  }));
  let current = opened;
  if (current.subject !== subject) {
    current = { subject, tabs: new Set() };
    setOpened(current);
  }
  current.tabs.add(activeTab);
  return current.tabs;
}

/** The strip's `gap-4`, which the fit counts between tabs. */
const GAP_PX = 16;
/** The menu before it has been drawn once: "ещё 10" and its chevron. */
const MENU_PX = 64;

/** The tabs the menu holds, and the width every tab together asks for. */
interface Fit {
  hidden: string[];
  natural: number | null;
}

function useFittedTabs({
  room,
  strip,
  menu,
  ids,
  open,
}: {
  room: React.RefObject<HTMLDivElement | null>;
  strip: React.RefObject<HTMLDivElement | null>;
  menu: React.RefObject<HTMLButtonElement | null>;
  ids: string;
  open: string;
}): Fit {
  const [fit, setFit] = useState<Fit>({ hidden: [], natural: null });
  const menuShown = fit.hidden.length > 0;
  useLayoutEffect(() => {
    const box = room.current;
    const list = strip.current;
    if (!box || !list) return;
    const measure = () => {
      // Not laid out, as inside a hidden panel: nothing is known to overflow.
      if (box.clientWidth === 0) return;
      const tabs = [...list.querySelectorAll<HTMLElement>("[data-tab]")];
      const widths = tabs.map((tab) => tab.getBoundingClientRect().width);
      const shown = fitTabs({
        widths,
        room: box.clientWidth,
        gap: GAP_PX,
        menu: menu.current?.getBoundingClientRect().width || MENU_PX,
        open: tabs.findIndex((tab) => tab.dataset.tab === open),
      });
      const next: Fit = {
        hidden: tabs
          .filter((_, index) => !shown[index])
          .map((tab) => tab.dataset.tab ?? ""),
        natural: Math.ceil(
          widths.reduce((sum, width) => sum + width, 0) +
            GAP_PX * Math.max(0, widths.length - 1)
        ),
      };
      setFit((prev) =>
        prev.natural === next.natural &&
        prev.hidden.join("\n") === next.hidden.join("\n")
          ? prev
          : next
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    for (const tab of list.querySelectorAll("[data-tab]"))
      observer.observe(tab);
    if (menu.current) observer.observe(menu.current);
    return () => observer.disconnect();
  }, [room, strip, menu, ids, open, menuShown]);
  return fit;
}

/** Every tab the strip cannot show, one click away and named, the open one marked. */
function HiddenTabs({
  tabs,
  open,
  onPick,
  buttonRef,
}: {
  tabs: DetailTab[];
  open: DetailTab | undefined;
  onPick: (tab: string) => void;
  buttonRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const t = useT();
  const label = t("action", "tabsMoreLabel", { n: tabs.length });
  const says = open
    ? `${label}. ${t("action", "tabsMoreHoldsOpen", { tab: open.label })}`
    : label;
  // WebKit rings the focus the menu hands back after a click as if a key had
  // brought it, so the ring follows the last input, as the tabs' own does.
  const [ring, setRing] = useState(false);
  const pointer = useRef(false);
  const keyed = useRef(false);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          ref={buttonRef}
          type="button"
          aria-label={says}
          title={open ? says : undefined}
          data-holds-open={open ? "true" : undefined}
          data-ring={ring ? "true" : undefined}
          onPointerDown={() => {
            pointer.current = true;
          }}
          onKeyDown={() => setRing(true)}
          onFocus={() => {
            setRing(!pointer.current);
            pointer.current = false;
          }}
          onBlur={() => setRing(false)}
          className={cn(
            "flex flex-none items-center gap-1 border-b pl-2 text-xs outline-hidden transition-colors hover:text-fg data-[ring=true]:ring-1 data-[ring=true]:ring-info",
            open ? "border-fg font-medium text-fg" : "border-hair text-fg-mut"
          )}
        >
          {t("action", "tabsMore", { n: tabs.length })}
          <ChevronDown className="h-3 w-3" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        onKeyDown={() => {
          keyed.current = true;
        }}
        onPointerDown={() => {
          keyed.current = false;
        }}
        onPointerDownOutside={() => {
          keyed.current = false;
        }}
        onCloseAutoFocus={() => {
          pointer.current = !keyed.current;
          keyed.current = false;
        }}
      >
        {tabs.map((tab) => {
          const isOpen = tab.id === open?.id;
          return (
            <DropdownMenuItem
              key={tab.id}
              onSelect={() => onPick(tab.id)}
              aria-current={isOpen ? "true" : undefined}
              className={cn("gap-1.5", isOpen && "font-medium text-fg")}
            >
              <TabGlyph glyph={tab.glyph} isActive={isOpen} />
              {tab.label}
              {tab.mark && <TabMark mark={tab.mark} isActive={isOpen} />}
              {isOpen && (
                <Check className="ml-auto h-3 w-3" aria-hidden="true" />
              )}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const tabOf = (target: EventTarget | null) =>
  target instanceof Element
    ? (target.closest<HTMLElement>("[data-tab]")?.dataset.tab ?? null)
    : null;

/** The tab holding the focus, and whether a key brought it there. */
interface Focused {
  id: string;
  ring: boolean;
}

export function DetailTabs({
  tabs,
  activeTab,
  onTabChange,
  actions,
  subject = "",
  onTabAgain,
}: {
  tabs: DetailTab[];
  activeTab: string;
  onTabChange: (tab: string) => void;
  /** A click on the tab already open, which Radix does not report as a change. */
  onTabAgain?: (tab: string) => void;
  /** Controls belonging to the page, pinned to the right of the same row. */
  actions?: React.ReactNode;
  /** Which object the tabs are about; a new one starts with nothing opened. */
  subject?: string;
}) {
  // A tab named by a link that this page does not have opens the first one
  // rather than none: a page with every panel hidden reads as broken.
  const requested = tabs.some((tab) => tab.id === activeTab);
  const current = requested || tabs.length === 0 ? activeTab : tabs[0].id;
  const opened = useOpenedTabs(current, subject);
  const surface = surfaceIsOpen(tabs, current);
  // Force-mounting a surface keeps its shell attached and its log stream
  // running, which is the point. It must not also keep its queries re-reading
  // the cluster for a panel nobody can see, and since the panel is mounted
  // nothing downstream can work that out for itself.
  const pageVisible = useSurfaceVisible();
  const roomRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLButtonElement>(null);
  const [focused, setFocused] = useState<Focused | null>(null);
  const pointer = useRef(false);
  const fit = useFittedTabs({
    room: roomRef,
    strip: stripRef,
    menu: menuRef,
    ids: tabs.map((tab) => tab.id).join("\n"),
    open: current,
  });
  const hidden = new Set(fit.hidden);
  // The strip's one Tab stop: the focused tab inside it, the open one
  // outside, or the first it shows when the menu holds the open one.
  const stop =
    focused?.id ??
    (hidden.has(current)
      ? tabs.find((tab) => !hidden.has(tab.id))?.id
      : current);

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
          their own row, and a tab the row still cannot hold goes to the
          menu whole. */}
      <div className="flex flex-wrap items-stretch gap-3">
        {/* Asks for every tab's width, so the actions wrap before a tab
            goes to the menu. */}
        <div
          ref={roomRef}
          className="flex min-w-0 flex-auto items-stretch"
          style={fit.natural === null ? undefined : { flexBasis: fit.natural }}
        >
          <TabsList
            ref={stripRef}
            tabIndex={-1}
            onPointerDown={() => {
              pointer.current = true;
            }}
            onKeyDownCapture={() => {
              pointer.current = false;
              setFocused((was) => was && { ...was, ring: true });
            }}
            onFocus={(event) => {
              const id = tabOf(event.target);
              if (id) setFocused({ id, ring: !pointer.current });
              pointer.current = false;
            }}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node))
                setFocused(null);
            }}
            className="relative h-auto min-w-0 flex-1 justify-start gap-4 overflow-hidden rounded-none border-b border-hair bg-transparent p-0 text-fg-mut"
          >
            {tabs.map((tab) => (
              <DetailTabTrigger
                key={tab.id}
                tab={tab}
                isActive={tab.id === current}
                isStop={tab.id === stop}
                ring={focused?.id === tab.id && focused.ring}
                overflow={hidden.has(tab.id)}
                onAgain={onTabAgain}
              />
            ))}
          </TabsList>
          {hidden.size > 0 && (
            <HiddenTabs
              tabs={tabs.filter((tab) => hidden.has(tab.id))}
              open={
                hidden.has(current)
                  ? tabs.find((tab) => tab.id === current)
                  : undefined
              }
              onPick={onTabChange}
              buttonRef={menuRef}
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
