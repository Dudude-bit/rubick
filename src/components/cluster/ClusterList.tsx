import { useEffect, useRef } from "react";

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
import { useClusterStore } from "@/stores/clusterStore";
import { useT } from "@/i18n/useT";

/**
 * The clusters in the kubeconfig, as the thing you act on rather than a
 * thing you are told about.
 *
 * Recent first; everything under "All contexts" is a reference list. A
 * cluster that has never been connected to has no recency to sort by, so
 * it keeps the kubeconfig's own order — the only order its author chose.
 *
 * Focus lands on the first row, arrows walk the list, Enter connects.
 */
export function ClusterList({
  onSelect,
  failedContext,
  autoFocus = true,
}: {
  onSelect: (context: string) => void;
  /** The cluster whose last connection attempt came back with an error. */
  failedContext?: string | null;
  autoFocus?: boolean;
}) {
  const t = useT();
  const contexts = useClusterStore((s) => s.contexts);
  const lastUsed = useClusterRecencyStore((s) => s.lastUsed);
  const listRef = useRef<HTMLDivElement>(null);

  const { recent, rest } = splitByRecency(contexts, lastUsed);
  const hasRows = contexts.length > 0;

  useEffect(() => {
    if (!autoFocus || !hasRows) return;
    listRef.current?.querySelector<HTMLElement>("[data-cluster-row]")?.focus();
    // Focus the head of the list when it first has rows in it, and not on
    // every change: re-focusing would drag the reader back to the top
    // mid-scroll every time a poll refreshed the context list.
  }, [autoFocus, hasRows]);

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

  return (
    <div
      ref={listRef}
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
