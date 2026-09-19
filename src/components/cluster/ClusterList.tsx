import { useEffect, useId, useRef } from "react";
import { Search } from "lucide-react";

import { ClusterMenu } from "@/components/cluster/ClusterMenu";
import { ClusterRow } from "@/components/cluster/ClusterRow";
import { Kbd } from "@/components/ui/kbd";
import { useRealtimeAge } from "@/hooks/useRealtimeAge";
import { detectProvider, providerLabel } from "@/lib/cluster-identity";
import { cn } from "@/lib/utils";
import {
  splitByRecency,
  useClusterRecencyStore,
} from "@/stores/clusterRecencyStore";
import { useT } from "@/i18n/useT";
import type { ContextInfo } from "@/generated/types";

/**
 * Whether something that traps the keyboard already has it.
 *
 * A `window` listener fires even under a Radix modal, which is a thing this
 * app has learned twice already. With the command palette open over the front
 * door, focus is inside its own trap, and pulling the caret to a box behind it
 * starts a fight the palette wins on the next render.
 */
function inOverlay(element: Element | null): boolean {
  return (
    element instanceof HTMLElement &&
    !!element.closest('[role="dialog"],[role="alertdialog"],[role="menu"]')
  );
}

/**
 * The clusters in the kubeconfig, as the thing you act on rather than a
 * thing you are told about.
 *
 * Recent first; everything under "All contexts" is a reference list. A
 * cluster that has never been connected to has no recency to sort by, so
 * it keeps the kubeconfig's own order — the only order its author chose.
 *
 * Focus lands on the first row, arrows walk the list, Enter connects. The
 * filter box above is always there but never takes the caret: with three
 * clusters it would be in the way, and `mod+F` is a cheaper way to reach it
 * than costing everybody their one-keystroke connect.
 *
 * The needle and the filtered list are owned by `useClusterFilter`, not here,
 * because the heading above this list counts the same rows.
 */
export function ClusterList({
  contexts,
  total,
  filter,
  onFilterChange,
  query,
  inputRef,
  onSelect,
  failedContext,
  autoFocus = true,
}: {
  /** Already filtered — see `useClusterFilter`. */
  contexts: ContextInfo[];
  /** How many contexts exist, which is not `contexts.length`. */
  total: number;
  filter: string;
  onFilterChange: (next: string) => void;
  /** The needle `contexts` was filtered by. */
  query: string;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onSelect: (context: string) => void;
  /** The cluster whose last connection attempt came back with an error. */
  failedContext?: string | null;
  autoFocus?: boolean;
}) {
  const t = useT();
  const lastUsed = useClusterRecencyStore((s) => s.lastUsed);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const { recent, rest } = splitByRecency(contexts, lastUsed);
  // `total`, never `contexts.length`: keyed on the filtered count this would
  // fire on the keystroke that empties the list and again on the one that
  // refills it, throwing the caret onto the first row mid-word.
  const hasRows = total > 0;

  useEffect(() => {
    if (!autoFocus || !hasRows) return;
    listRef.current?.querySelector<HTMLElement>("[data-cluster-row]")?.focus();
    // Focus the head of the list when it first has rows in it, and not on
    // every change: re-focusing would drag the reader back to the top
    // mid-scroll every time a poll refreshed the context list.
  }, [autoFocus, hasRows]);

  // Claimed only where this list *is* the screen. `autoFocus` already carries
  // that distinction, so the pane inside a resource page keeps the box and
  // leaves the shortcut alone — and two mounted lists can never both answer
  // one keypress.
  useEffect(() => {
    if (!autoFocus) return;
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) {
        return;
      }
      if (event.key.toLowerCase() !== "f") return;
      if (inOverlay(document.activeElement)) return;
      // Windows WebView2 has a find-on-page of its own, and this is the only
      // thing standing between the shortcut and it.
      event.preventDefault();
      inputRef.current?.focus();
      // Selected rather than appended to, so a second press or a paste
      // replaces the old needle instead of growing it.
      inputRef.current?.select();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [autoFocus, inputRef]);

  // The rows are the tab stop, not each other: a list is one control, and
  // tabbing through fifteen clusters to reach the kubeconfig path below
  // is what makes people use the mouse.
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step =
      event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (!step && event.key !== "Home" && event.key !== "End") return;
    const rows = Array.from(
      listRef.current?.querySelectorAll<HTMLElement>("[data-cluster-row]") ?? []
    );
    if (rows.length === 0) return;
    event.preventDefault();
    const at = rows.indexOf(document.activeElement as HTMLElement);
    // Up off the top goes to the filter box rather than nowhere. Not a wrap:
    // the bottom of this list still means "least used".
    if (event.key === "ArrowUp" && at === 0) {
      inputRef.current?.focus();
      return;
    }
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? rows.length - 1
          : // Clamped rather than wrapping: the ends of this list mean
            // "most used" and "least used", and skipping between them on
            // a held arrow key is how you connect to the wrong cluster.
            Math.min(Math.max(at + step, 0), rows.length - 1);
    rows[next]?.focus();
  };

  const onFilterKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      // An empty box has nothing to clear, and blurring would leave the caret
      // nowhere — let it bubble to whatever encloses this list instead.
      if (filter === "") return;
      event.preventDefault();
      onFilterChange("");
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "Enter") return;
    const first =
      listRef.current?.querySelector<HTMLElement>("[data-cluster-row]");
    if (!first) return;
    event.preventDefault();
    // Enter lands on the row rather than connecting from here. Picking the
    // wrong cluster is the expensive mistake on this screen, and the row is
    // where the alias, the real context name and the provider are all
    // legible — so the second Enter is the one that commits.
    first.focus();
  };

  return (
    <div className="flex flex-col">
      <div className="mb-1.5 flex h-7 items-center gap-1.5 rounded px-1.5 text-fg-fnt transition-colors hover:bg-hover focus-within:bg-hover">
        <Search className="h-3.5 w-3.5 flex-none" aria-hidden="true" />
        {/* Not a combobox: these rows are real buttons that take focus and
            open a menu of their own, so advertising `aria-autocomplete`
            would promise the caret stays here, which it does not. */}
        <input
          ref={inputRef}
          type="text"
          value={filter}
          onChange={(event) => onFilterChange(event.target.value)}
          onKeyDown={onFilterKeyDown}
          aria-label={t("action", "filterClusters")}
          placeholder={t("action", "filterClustersPlaceholder")}
          aria-controls={listId}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          className="min-w-0 flex-1 bg-transparent text-xs text-fg outline-hidden placeholder:text-fg-fnt"
        />
        {/* Only where the shortcut is actually claimed. */}
        {autoFocus && <Kbd shortcut="mod+F" className="leading-[13px]" />}
      </div>

      <div
        ref={listRef}
        id={listId}
        role="listbox"
        aria-label={t("cluster", "clustersInKubeconfig")}
        onKeyDown={onKeyDown}
        className="flex flex-col"
      >
        {recent.length > 0 && rest.length > 0 && (
          <Caption>{t("cluster", "recent")}</Caption>
        )}
        {recent.map((ctx) => (
          <ClusterListRow
            key={ctx.name}
            context={ctx.name}
            lastUsedAt={lastUsed[ctx.name]}
            failed={ctx.name === failedContext}
            onSelect={onSelect}
          />
        ))}

        {recent.length > 0 && rest.length > 0 && (
          <Caption>{t("cluster", "allContexts")}</Caption>
        )}
        {rest.map((ctx) => (
          <ClusterListRow
            key={ctx.name}
            context={ctx.name}
            failed={ctx.name === failedContext}
            onSelect={onSelect}
          />
        ))}
      </div>

      {/* Outside the listbox: a sentence is not an option anyone can pick.
          Two of them, because "your filter excluded everything" and "the
          kubeconfig names no cluster" call for opposite next moves. There is
          no third "could not look" state to carry — `ClusterFrontDoor`
          answers loading and an unreadable kubeconfig before reaching here,
          so do not add a default. */}
      {contexts.length === 0 && (
        <>
          <p className="px-[7px] py-2 text-[11px] text-fg-fnt">
            {total === 0
              ? t("empty", "noContextsInKubeconfig")
              : t("empty", "nothingMatchesQuery", { query })}
          </p>
          {/* A dead end needs a way out that is not select-all-and-delete. */}
          {total > 0 && (
            <button
              type="button"
              onClick={() => {
                onFilterChange("");
                inputRef.current?.focus();
              }}
              className="self-start rounded-sm px-[7px] text-[11px] text-fg-mut underline decoration-dotted underline-offset-2 transition-colors hover:text-fg focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-info"
            >
              {t("action", "clearSearch")}
            </button>
          )}
        </>
      )}
    </div>
  );
}

function Caption({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-1 mt-5 text-[10px] uppercase tracking-[0.06em] text-fg-fnt first:mt-0">
      {children}
    </p>
  );
}

function ClusterListRow({
  context,
  lastUsedAt,
  failed,
  onSelect,
}: {
  context: string;
  lastUsedAt?: number;
  failed?: boolean;
  onSelect: (context: string) => void;
}) {
  const t = useT();
  const age = useRealtimeAge(
    lastUsedAt ? new Date(lastUsedAt).toISOString() : null
  );

  return (
    // Right is the key, not Down: Down already walks this list, and a menu
    // that stole it would make the list unusable to get to the menu.
    <ClusterMenu context={context} openKeys={["ArrowRight"]}>
      <button
        type="button"
        role="option"
        aria-selected={false}
        aria-haspopup="menu"
        data-cluster-row
        onClick={() => onSelect(context)}
        className={cn(
          "group mx-[-7px] rounded-[5px] text-left transition-colors hover:bg-hover",
          "focus:bg-sel focus:outline-hidden"
        )}
      >
        <ClusterRow
          context={context}
          failed={failed}
          meta={
            <span className="flex items-center gap-1.5">
              {failed
                ? "failed"
                : lastUsedAt
                  ? `last used ${age} ago`
                  : providerLabel(detectProvider(context)).toLowerCase()}
              {/* Both ways in are only worth their width on the row the
                  reader is standing on. The arrow is spelled out for
                  screen readers by `aria-keyshortcuts` on the trigger, so
                  the glyph here is decoration and says so. */}
              <Kbd
                shortcut="Enter"
                className="hidden leading-[13px] group-focus:inline-block"
              />
              <span
                aria-hidden="true"
                className="hidden items-center gap-1 group-focus:inline-flex"
              >
                <Kbd shortcut="→" className="leading-[13px]" />
                {t("cluster", "rename")}
              </span>
            </span>
          }
        />
      </button>
    </ClusterMenu>
  );
}
