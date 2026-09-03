import * as React from "react";
import { Search, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { SETTINGS_SECTIONS } from "./settings-sections";
import { useSettingsSearch } from "./settings-search";
import { useT } from "@/i18n/useT";

const ITEM_ATTR = "data-settings-nav-item";

/**
 * The section list, and the search that filters what is in them.
 *
 * This is the second nav on screen and it must not read as a second rail.
 * Where the app's own sidebar marks its row with a rounded fill and lifts
 * the icon to the accent colour, a section here is marked by a rule down
 * its left edge and keeps its icon in the same grey as the label: page
 * furniture, not app furniture.
 */
export function SettingsNav({
  activeId,
  onSelect,
}: {
  activeId: string;
  onSelect: (id: string) => void;
}) {
  const { query, setQuery, terms, counts } = useSettingsSearch();
  const t = useT();
  const listRef = React.useRef<HTMLDivElement>(null);
  const searching = terms.length > 0;

  // The list is one tab stop, not five: tabbing through every section to
  // reach the pane is what sends people back to the mouse. Arrows move
  // within it, clamped at the ends.
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const forward = event.key === "ArrowDown" || event.key === "ArrowRight";
    const back = event.key === "ArrowUp" || event.key === "ArrowLeft";
    if (!forward && !back && event.key !== "Home" && event.key !== "End")
      return;
    const items = Array.from(
      listRef.current?.querySelectorAll<HTMLElement>(`[${ITEM_ATTR}]`) ?? []
    );
    if (items.length === 0) return;
    event.preventDefault();
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : Math.min(Math.max(at + (forward ? 1 : -1), 0), items.length - 1);
    items[next]?.focus();
  };

  return (
    <div
      // The rule stops under the last section rather than running the
      // page's full height. A hairline down an empty gutter is what would
      // make this read as a second rail instead of a list of five links
      // belonging to the page.
      className="flex w-44 flex-none flex-col gap-1.5 self-start border-r border-hair py-1 pr-2"
    >
      {/* A search field is a text entry, not a panel: the box only appears
          once it has focus or a value. */}
      <div className="mx-1 flex h-7 items-center gap-1.5 rounded px-1.5 text-fg-fnt transition-colors hover:bg-hover focus-within:bg-hover">
        <Search className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <input
          type="search"
          aria-label={t("settings", "searchSettings")}
          placeholder={t("settings", "searchSettings")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && query) {
              event.stopPropagation();
              setQuery("");
            }
          }}
          className="min-w-0 flex-1 bg-transparent text-xs text-fg outline-hidden placeholder:text-fg-fnt [&::-webkit-search-cancel-button]:hidden"
        />
        {query && (
          <button
            type="button"
            aria-label={t("settings", "clearSearch")}
            onClick={() => setQuery("")}
            className="rounded text-fg-fnt transition-colors hover:text-fg focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-info"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>

      <div
        ref={listRef}
        onKeyDown={onKeyDown}
        role="navigation"
        aria-label={t("settings", "settingsSections")}
        className="flex flex-col"
      >
        {SETTINGS_SECTIONS.map((section) => {
          const active = section.id === activeId;
          const count = counts[section.id] ?? 0;
          // Dimmed, not hidden: a section that holds nothing for this
          // query is still somewhere the reader can go.
          const empty = searching && count === 0;
          return (
            <button
              key={section.id}
              type="button"
              onClick={() => onSelect(section.id)}
              {...{ [ITEM_ATTR]: "" }}
              tabIndex={active ? 0 : -1}
              aria-current={active ? "true" : undefined}
              // The count sits flush against the label, so read aloud the
              // pair is "About1". Say what the number counts instead.
              aria-label={
                searching
                  ? t("settings", "navMatching", {
                      label: t("settings", section.label),
                      n: count,
                    })
                  : t("settings", section.label)
              }
              className={cn(
                "flex h-7 flex-none items-center gap-2 border-l-2 border-transparent pl-2.5 pr-2 text-left text-xs text-fg-mut transition-colors hover:bg-hover hover:text-fg focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-info",
                active && "border-l-fg bg-sel font-medium text-fg",
                empty && "opacity-55"
              )}
            >
              <section.icon
                className={cn(
                  "h-3.5 w-3.5 flex-none",
                  !active && "text-fg-fnt"
                )}
                aria-hidden="true"
              />
              <span className="truncate">{t("settings", section.label)}</span>
              {searching && count > 0 && (
                <span className="ml-auto pl-1 font-mono text-[11px] text-fg-fnt">
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
