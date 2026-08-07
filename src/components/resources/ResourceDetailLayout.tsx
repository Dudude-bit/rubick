/**
 * The frame every resource detail page sits in: the header, the page's own
 * blocks and the tab strip.
 *
 * Nothing here draws a surface. Sections are separated by 22px of canvas and
 * the occasional hairline, which is the same rhythm the overview uses.
 */

import type { ReactNode } from "react";
import { AlertCircle, ArrowLeft, RefreshCw } from "lucide-react";

import { DetailSkeleton } from "@/components/ui/skeleton";
import { CaptionScope, Section } from "@/components/ui/section";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { isResourceNotFoundError } from "@/hooks/useResourceDetail";
import { cn } from "@/lib/utils";
import { ResourceDetailHeader } from "./ResourceDetailHeader";
import { DetailAction } from "./detail-blocks";

interface DetailErrorProps {
  error: Error | string | null;
  resourceKind: string;
  onBack: () => void;
  /** Pods are replaced rather than restarted, so a 404 offers to follow. */
  onFindReplacement?: () => void;
  isSearching?: boolean;
  additionalMessage?: string;
}

export function DetailError({
  error,
  resourceKind,
  onBack,
  onFindReplacement,
  isSearching,
  additionalMessage,
}: DetailErrorProps) {
  const isNotFound = isResourceNotFoundError(error);
  const kind = resourceKind.toLowerCase();

  return (
    <Section className="max-w-lg">
      <div className="flex items-center gap-2">
        <AlertCircle className="h-4 w-4 text-err" aria-hidden="true" />
        <h2 className="text-[13px] font-semibold tracking-tight text-err">
          {isNotFound
            ? `${resourceKind} not found`
            : `Could not read this ${kind}`}
        </h2>
      </div>
      <p className="text-xs text-fg-mut">
        {isNotFound
          ? `The ${kind} may have been deleted or recreated under a new name.`
          : typeof error === "string"
            ? error
            : (error?.message ?? "The cluster did not answer.")}
      </p>
      {additionalMessage && (
        <p className="text-xs text-fg-mut">{additionalMessage}</p>
      )}
      <div className="flex items-center gap-1 pt-1">
        <DetailAction label="Go back" icon={ArrowLeft} onClick={onBack} />
        {isNotFound && onFindReplacement && (
          <DetailAction
            label={isSearching ? "Searching…" : "Find replacement"}
            icon={RefreshCw}
            onClick={onFindReplacement}
            busy={isSearching}
          />
        )}
      </div>
    </Section>
  );
}

export interface DetailTab {
  id: string;
  label: string;
  content: ReactNode;
  /**
   * What the tab is made of, which is what decides the space above it and
   * who owns the page's height.
   *
   * "sections" is the page rhythm: a stack of blocks with 22px of canvas
   * between them and 18px under the tab strip, in a page that flows and
   * scrolls. "surface" is one full-height pane that brings its own chrome —
   * a log viewer, an editor, a terminal. Two things follow from that. The
   * rhythm is wrong for it: the first row of such a pane is a toolbar, and
   * canvas above a toolbar reads as a hole rather than as breathing room.
   * And the height is its: a pane with its own scrollbar inside a page with
   * another one is two scrollbars over the same content, and the reader has
   * to scroll the outer one to see the foot of the inner. A surface tab
   * pins the page to the window and takes every pixel the chrome above it
   * does not.
   */
  kind?: "sections" | "surface";
}

interface ResourceDetailLayoutProps {
  resource: unknown;
  isLoading: boolean;
  error: Error | string | null;
  /** Kind, used for the breadcrumb and every "not found" message. */
  resourceKind: string;
  /** Breadcrumb overrides for kinds the resource registry does not own. */
  listUrl?: string;
  listLabel?: string;

  /** The object's name. */
  title: string;
  namespace?: string;
  createdAt?: string | null;
  statusBadge?: ReactNode;
  /** Qualifiers shown beside the name. */
  badges?: ReactNode;
  /**
   * What this page lets you do to the object, as `DetailAction`s.
   *
   * Rendered at the right end of the tab strip rather than in the header.
   * How many fit: the peek panel folds its overflow into a More menu past
   * five controls in a row, and that budget is not re-derived here because
   * nothing reaches it — a Pod's four is the widest set in the app and a
   * Deployment's Scale, Restart and Delete is three. What is scarce on this
   * row is width rather than count, since the tab strip is on it too, so the
   * rule is which of the two gives way: the actions are pinned to the right
   * at their natural width and the tab labels truncate, because an action
   * that wrapped onto a second line would undo the whole point of the row.
   */
  actions?: ReactNode;

  onBack: () => void;
  onFindReplacement?: () => void;
  isSearchingReplacement?: boolean;

  tabs: DetailTab[];
  activeTab: string;
  onTabChange: (tab: string) => void;

  children?: ReactNode;
}

export function ResourceDetailLayout({
  resource,
  isLoading,
  error,
  resourceKind,
  listUrl,
  listLabel,
  title,
  namespace,
  createdAt,
  statusBadge,
  badges,
  actions,
  onBack,
  onFindReplacement,
  isSearchingReplacement,
  tabs,
  activeTab,
  onTabChange,
  children,
}: ResourceDetailLayoutProps) {
  if (isLoading) {
    return <DetailSkeleton />;
  }

  if (error || !resource) {
    return (
      <DetailError
        error={error}
        resourceKind={resourceKind}
        onBack={onBack}
        onFindReplacement={onFindReplacement}
        isSearching={isSearchingReplacement}
      />
    );
  }

  // Collapsing is not a control the reader operates: clicking "Logs" already
  // said what they came for, and a toggle would spend a slot in the very row
  // it exists to shrink. Reversing it is the Overview tab, one click away.
  //
  // Unless there is nowhere to reverse to. Hiding the page's own blocks is
  // only fair while another tab still shows them; a page whose every tab is a
  // surface would hide them for good, which is how PersistentVolume lost its
  // capacity, binding and reclaim policy entirely.
  const hasSectionsTab = tabs.some((tab) => tab.kind !== "surface");
  const surface =
    hasSectionsTab &&
    tabs.find((tab) => tab.id === activeTab)?.kind === "surface";

  return (
    <CaptionScope kind={resourceKind}>
      <div
        className={cn(
          "flex flex-col animate-in fade-in duration-200",
          surface ? "h-full min-h-0 gap-2" : "gap-[22px]"
        )}
      >
        <ResourceDetailHeader
          name={title}
          kind={resourceKind}
          listUrl={listUrl}
          listLabel={listLabel}
          namespace={namespace}
          createdAt={createdAt}
          status={statusBadge}
          meta={badges}
          onBack={onBack}
        />

        {/* `contents` so the page's own blocks keep sitting in this column at
            its own rhythm; `hidden` takes all of them off a surface tab at
            once. Kept mounted either way — the dialogs a page hangs here
            portal to the body and have to survive the tab that opened them. */}
        {children && (
          <div className={surface ? "hidden" : "contents"}>{children}</div>
        )}

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
            <TabsList className="h-auto min-w-0 flex-1 justify-start gap-3 rounded-none border-b border-hair bg-transparent p-0 text-fg-mut">
              {tabs.map((tab) => (
                <TabsTrigger
                  key={tab.id}
                  value={tab.id}
                  className="-mb-px h-7 min-w-0 truncate rounded-none border-b border-transparent px-0.5 pb-1.5 pt-0 text-xs font-normal text-fg-mut shadow-none transition-colors hover:text-fg data-[state=active]:border-fg data-[state=active]:bg-transparent data-[state=active]:font-medium data-[state=active]:text-fg data-[state=active]:shadow-none"
                >
                  {tab.label}
                </TabsTrigger>
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
      </div>
    </CaptionScope>
  );
}

export default ResourceDetailLayout;
