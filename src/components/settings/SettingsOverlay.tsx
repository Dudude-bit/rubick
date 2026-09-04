/**
 * Settings, as a layer over the window rather than a page in a tab.
 *
 * As a route it was a page of whichever tab was active: opening it took the
 * reader off the list they were on, retitled the tab, and stood behind every
 * gate in front of the outlet, so a refused session or a tab mid-switch hid
 * the one screen that could fix either. As a layer it opens over anything:
 * the front door, an expired session, a page half-loaded. It closes back
 * onto exactly the page it covered.
 *
 * The nav does not fold, and the arithmetic is why. The section nav is 176
 * wide and the pane needs about 520 to still fit a path field with its
 * browse button beside it; the window's `minWidth` is 1024, which leaves
 * the pane over 700 at the narrowest anybody can drag to.
 */

import { useEffect, useRef } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";

import { RegistrySettings } from "@/components/registry/RegistrySettings";
import { Kbd } from "@/components/ui/kbd";
import { useClusterStore } from "@/stores/clusterStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { cn } from "@/lib/utils";
import { useT, type T } from "@/i18n/useT";
import { AboutSettings } from "./AboutSettings";
import { AppearanceSettings } from "./AppearanceSettings";
import { ClustersSettings } from "./ClustersSettings";
import { DiagnosticsSettings } from "./DiagnosticsSettings";
import { SettingsNav } from "./SettingsNav";
import { SettingsSearchable } from "./settings-row";
import {
  SettingsSearchProvider,
  SettingsSectionScope,
  useSettingsSearch,
} from "./settings-search";
import { SETTINGS_SECTIONS } from "./settings-sections";

function sectionContent(id: string, t: T) {
  switch (id) {
    case "appearance":
      return <AppearanceSettings />;
    case "clusters":
      return <ClustersSettings />;
    case "registries":
      // Registries keeps its own editor, which is not built from rows, so
      // the section is indexed as one thing.
      return (
        <SettingsSearchable keywords={t("settings", "searchRegistryWords")}>
          <RegistrySettings />
        </SettingsSearchable>
      );
    case "diagnostics":
      return <DiagnosticsSettings />;
    case "about":
      return <AboutSettings />;
    default:
      return null;
  }
}

function SettingsShell() {
  const t = useT();
  const { query, terms, counts } = useSettingsSearch();
  const currentContext = useClusterStore((state) => state.currentContext);
  const activeId = useSettingsStore((state) => state.section);
  const openSettings = useSettingsStore((state) => state.openSettings);
  const searching = terms.length > 0;

  const active =
    SETTINGS_SECTIONS.find((section) => section.id === activeId) ??
    SETTINGS_SECTIONS[0];
  const matched = counts[active.id] ?? 0;

  return (
    <div className="flex h-full min-h-0 flex-row">
      <SettingsNav activeId={active.id} onSelect={openSettings} />

      <div className="min-w-0 flex-1 overflow-auto scrollbar-thin pb-8 pl-5 pr-1 pt-1">
        {/* Capped, because a row 950px wide puts the control it belongs to
            at the other end of the screen from its label. */}
        <div className="max-w-3xl">
          <div className="flex items-baseline gap-2.5">
            <h1 className="text-[13px] font-semibold text-fg">
              {t("settings", active.label)}
            </h1>
            <span className="text-[11px] text-fg-fnt">
              {searching ? (
                matched === 0 ? (
                  <>{t("settings", "nothingHereMatches", { query })}</>
                ) : (
                  <>
                    {t("count", "settingsMatch", { n: matched })} &ldquo;
                    {query}&rdquo;
                  </>
                )
              ) : active.clusterScoped && currentContext ? (
                <>
                  {t("settings", "inWord")}{" "}
                  <span className="font-mono">{currentContext}</span>
                </>
              ) : null}
            </span>
          </div>
          <p className="mb-4 mt-0.5 max-w-[70ch] text-[11px] text-fg-fnt">
            {t("settings", active.description)}
          </p>

          {SETTINGS_SECTIONS.map((section) => {
            const isActive = section.id === active.id;
            // A search that only counted the section you are standing in
            // would dim the other four regardless of what they hold, so a
            // query is what mounts them. Nothing is fetched for a section
            // nobody has asked about until somebody starts typing.
            if (!isActive && !searching) return null;
            return (
              <div
                key={section.id}
                className={cn(!isActive && "hidden")}
                hidden={!isActive}
              >
                <SettingsSectionScope id={section.id}>
                  {sectionContent(section.id, t)}
                </SettingsSectionScope>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/**
 * `mod+,` toggles, the way every desktop app's preferences open. Registered
 * here rather than beside the tab shortcuts because this one has to work
 * on every screen, including the ones that have no tabs yet.
 */
function useSettingsShortcut() {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey)
        return;
      if (event.key !== ",") return;
      event.preventDefault();
      useSettingsStore.getState().toggleSettings();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}

/**
 * The layer, and the one dismissal it takes away from Radix.
 *
 * Split from `SettingsOverlay` so the search state sits *above* the content:
 * Radix listens for Escape on the document in the capture phase, so a
 * `stopPropagation` inside the search input never reaches it — pressing Escape
 * to clear a filter closed the whole of Settings instead. `onEscapeKeyDown` is
 * where Radix looks, and it can only be answered from outside the provider.
 * `PeekPanel` takes a dismissal away the same way.
 */
function SettingsLayer({ onClose }: { onClose: () => void }) {
  const t = useT();
  const contentRef = useRef<HTMLDivElement>(null);
  const { query, setQuery } = useSettingsSearch();

  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Content
        ref={contentRef}
        aria-describedby={undefined}
        onEscapeKeyDown={(event) => {
          if (!query) return;
          event.preventDefault();
          setQuery("");
        }}
        // Focus lands on the open section, not on the search box: arrows then
        // move between sections, and typing is one Tab away.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          contentRef.current
            ?.querySelector<HTMLElement>('[aria-current="true"]')
            ?.focus();
        }}
        // Opaque and app-coloured on purpose: Settings belongs to the app, not
        // to the cluster whose colour runs along the top of the page
        // underneath. A fade only: a full-window panel that zooms in reads as
        // the window itself moving.
        //
        // Its own element rather than a `SheetContent` variant. A sheet is a
        // panel anchored to an edge, raised above the page and sliding in; a
        // variant for this would override the anchor, the raise, the padding
        // and the animation — everything the base sets — which is a new
        // component wearing a variant's name. The first attempt at that also
        // dropped `display:flex`, so the header and the scrolling body below
        // silently stopped laying out.
        className="fixed inset-0 z-50 flex flex-col bg-canvas text-fg-mid duration-150 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 motion-reduce:animate-none"
      >
        {/* Header and body share one centred column, so the title sits on the
            nav's left edge and the close on the pane's right. */}
        <header className="flex h-10 flex-none items-center border-b border-hair px-4">
          <div className="mx-auto flex w-full max-w-5xl items-center">
            <DialogPrimitive.Title className="text-[13px] font-semibold text-fg">
              {t("nav", "settings")}
            </DialogPrimitive.Title>
            <DialogPrimitive.Close
              aria-label={t("action", "close")}
              onClick={onClose}
              className="ml-auto flex h-7 items-center gap-1.5 rounded px-1.5 text-fg-fnt transition-colors hover:bg-hover hover:text-fg focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-info"
            >
              <Kbd shortcut="Esc" />
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </DialogPrimitive.Close>
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-hidden px-4 pt-3">
          <div className="mx-auto h-full w-full max-w-5xl">
            <SettingsShell />
          </div>
        </div>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function SettingsOverlay() {
  const open = useSettingsStore((state) => state.open);
  const closeSettings = useSettingsStore((state) => state.closeSettings);
  useSettingsShortcut();

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) closeSettings();
      }}
    >
      {/* Above the content, so the Escape handler inside can read the query.
          The provider used to sit inside, which is why Escape in the search
          box could not be answered without closing the layer. */}
      <SettingsSearchProvider>
        <SettingsLayer onClose={closeSettings} />
      </SettingsSearchProvider>
    </DialogPrimitive.Root>
  );
}
