/**
 * The tab strip, and the panels under it.
 *
 * Lifted out of `ResourceDetailLayout` when the first screen that is not a
 * resource detail page needed one. The two rules a tab is drawn by —
 * `detail-tab.ts`'s glyph and its earned mark — are worth exactly as much on
 * an integration's page as on a Deployment's, and a second strip drawn beside
 * this one would have drifted from it by the second vendor.
 *
 * Everything about the header, the breadcrumb and the actions stayed behind:
 * this is the strip and nothing else.
 */

import { useState } from "react";
import { CircleDashed } from "lucide-react";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CaptionScope } from "@/components/ui/section";
import { kindHue } from "@/lib/resource-identity";
import {
  getResourceDefinition,
  isResourceType,
  toKind,
} from "@/lib/resource-registry";
import { cn } from "@/lib/utils";
import { useDisplaySettingsStore } from "@/stores/displaySettingsStore";
import {
  surfaceIsOpen,
  type DetailTab,
  type DetailTabGlyph,
  type DetailTabMark,
} from "./detail-tab";

/** 5px, which is the smallest disc that still reads as round rather than as dirt. */
const DOT = "h-[5px] w-[5px] flex-none rounded-full";

/**
 * A mark, and the words it stands for.
 *
 * Colour never carries it alone. The dot sits beside a label that changed,
 * and `says` reaches the accessible name — "Containers — 1 of 4 failing" —
 * because a red disc is nothing at all to a reader who cannot see red.
 */
function TabMark({
  mark,
  isActive,
}: {
  mark: DetailTabMark;
  isActive: boolean;
}) {
  if (mark.shows === "count") {
    return (
      <span
        className={cn(
          "flex-none text-[11px] tabular-nums",
          isActive ? "text-fg-mut" : "text-fg-fnt"
        )}
      >
        {mark.of}
      </span>
    );
  }
  if (mark.shows === "severity") {
    return (
      <span
        aria-hidden="true"
        className={cn(DOT, mark.tone === "err" ? "bg-err" : "bg-warn")}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className={cn(DOT, "animate-tab-live bg-ok motion-reduce:animate-none")}
    />
  );
}

/**
 * One tab, drawn by the two rules rather than by its label.
 *
 * The hue is read from the same `kindHue` the sidebar and every reference
 * use, and honours the colouring setting for the same reason they do: a
 * reader who turned identity colour off did not ask for one strip to keep it.
 */
function DetailTabTrigger({
  tab,
  isActive,
}: {
  tab: DetailTab;
  isActive: boolean;
}) {
  const colouring = useDisplaySettingsStore((state) => state.resourceColouring);
  const { Icon, hue } = resolveGlyph(tab.glyph, colouring !== "off");
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
      <Icon
        aria-hidden="true"
        className={cn(
          "h-3.5 w-3.5 flex-none",
          hue === null &&
            (isActive ? "text-fg" : "text-fg-fnt group-hover:text-fg-mut")
        )}
        style={
          hue === null
            ? undefined
            : { color: `hsl(${hue} var(--kind-s) var(--kind-l))` }
        }
      />
      <span className="truncate">{tab.label}</span>
      {tab.mark && <TabMark mark={tab.mark} isActive={isActive} />}
    </TabsTrigger>
  );
}

function resolveGlyph(glyph: DetailTabGlyph, tinted: boolean) {
  if (glyph.names === "view") return { Icon: glyph.icon, hue: null };
  const resolved = isResourceType(glyph.kind) ? toKind(glyph.kind) : null;
  return {
    // A kind the registry does not carry — a CRD's own kind, on its Instances
    // tab — gets the same dashed circle it gets in every list of them.
    Icon: resolved ? getResourceDefinition(resolved).icon : CircleDashed,
    hue: tinted ? kindHue(glyph.kind) : null,
  };
}

/**
 * Which tabs have been opened at least once.
 *
 * Radix unmounts the panel of every tab that is not the open one, which is
 * right for a stack of blocks and wrong for a surface: a surface is a place
 * with something live in it — an attached shell, a log stream, an editor's
 * undo history — and unmounting it is not hiding it, it is ending it. So a
 * surface panel stays mounted once it has been opened.
 *
 * Once it has been *opened*, and not before: force-mounting every surface on
 * arrival would open an exec session into a pod nobody asked to shell into,
 * and start a log stream for a reader who came for the Overview.
 *
 * The set is grown in render rather than in an effect: by the time this render
 * runs the tab is already the active one, and its panel has to be in this
 * pass's output. Adding a member nobody has read yet schedules nothing and is
 * idempotent, so a double render arrives at the same set.
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

  return (
    <Tabs
      value={activeTab}
      onValueChange={onTabChange}
      className={surface ? "flex min-h-0 flex-1 flex-col" : undefined}
    >
      {/* One control row rather than two. The strip is an underline, not a
          pill row: the window already has a pill tab strip for scopes, and
          two of them on one screen read as the same control at two levels.
          The page's actions share the row's hairline so it reads as one
          band, and are held off by a pip — a control sitting flush against
          a tab strip reads as another destination, and "Delete" is the one
          word in the app that must never be mistaken for a place to go. */}
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
          {/* The strip has just said this word; whatever the tab opens
              with does not have to say it again. */}
          <CaptionScope tab={tab.label}>{tab.content}</CaptionScope>
        </TabsContent>
      ))}
    </Tabs>
  );
}
