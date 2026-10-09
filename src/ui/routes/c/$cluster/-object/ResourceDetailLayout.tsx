/**
 * The frame every resource detail page sits in: the header, what is wrong with
 * the object, and the tab strip.
 *
 * The order is the whole point. Identity, then the one or two lines that say
 * the object is in trouble, then the strip — which carries the page's actions
 * on its row. Nothing of the page's own grows above that strip, so Scale,
 * Restart and Delete are above the fold by construction rather than by luck:
 * this frame used to render the page's blocks between the header and the
 * strip, and the day the Overview stopped being two short columns the controls
 * left the screen.
 *
 * Nothing here draws a surface. Sections are separated by 22px of canvas and
 * the occasional hairline, which is the same rhythm the overview uses.
 */

import type { AppLink } from "@/lib/links";
import { useEffect, useMemo, type ReactNode } from "react";
import { AlertCircle, ArrowLeft, Network, RefreshCw } from "lucide-react";

import { DetailSkeleton } from "@/components/ui/skeleton";
import { CaptionScope, Section } from "@/components/ui/section";
import { Unknown } from "@/components/ui/unknown";
import { isResourceNotFoundError } from "@/hooks/useResourceDetail";
import { useLastOwners, type Owner } from "@/hooks/useLastOwners";
import { GoneNotice } from "./gone";
import { DETAIL_TAB_OPEN } from "@/lib/shortcuts";
import { AlertBanner } from "../-alerts/AlertBanner";
import { AttachedFrom } from "./Attached";
import { errorToShow } from "@/lib/error-utils";
import { cn } from "@/lib/utils";
import { ResourceDetailHeader } from "./ResourceDetailHeader";
import { DetailTabs } from "@/components/object/DetailTabs";
import { DetailAction } from "@/components/object/detail-blocks";
import { DeliveryBanner, DeliveryMarks, HelmMark } from "../-delivery/delivery";
import {
  surfaceIsOpen,
  viewGlyph,
  type DetailTab,
} from "@/components/object/detail-tab";
import { OwnsPanel } from "./Owns";
import { StaleRows } from "../-list/StaleRows";
import { servedOfKind, useLineage } from "./ownership";
import { useOwnershipKeys } from "./ownership-keys";
import type { ServedResource } from "./served";
import { useDelivery } from "../-delivery/useDelivery";
import type { Freshness } from "@/hooks/useLiveQuery";
import type { DeliveryQuery } from "@/integrations";
import { useT } from "@/i18n/useT";
import { ShareObjectAction } from "@/components/share/ShareAction";
import type {
  ShareContribution,
  ShareFrame,
} from "@/components/share/contribution";

/** Kept reachable from here: the pages that hold a `DetailTab[]` import both. */
export type { DetailTab } from "@/components/object/detail-tab";

interface DetailErrorProps {
  error: Error | string | null;
  resourceKind: string;
  namespace?: string | null;
  /** What the object's last read named as its owners, when it was ever read. */
  owners?: Owner[];
  onBack: () => void;
  /** Pods are replaced rather than restarted, so a 404 offers to follow. */
  onFindReplacement?: () => void;
  isSearching?: boolean;
  additionalMessage?: string;
  /** What else ended with an object that is gone. */
  goneNote?: ReactNode;
}

export function DetailError({
  error,
  resourceKind,
  namespace = null,
  owners,
  onBack,
  onFindReplacement,
  isSearching,
  additionalMessage,
  goneNote,
}: DetailErrorProps) {
  const t = useT();
  const isNotFound = isResourceNotFoundError(error);

  return (
    <Section className="max-w-lg">
      {isNotFound && error ? (
        // The peek's answer for the same 404, so the two never disagree.
        <GoneNotice
          kind={resourceKind}
          namespace={namespace}
          owners={owners}
          error={error}
        />
      ) : (
        <div className="flex items-center gap-2">
          <AlertCircle className="h-4 w-4 text-err" aria-hidden="true" />
          <h2 className="text-[13px] font-semibold tracking-tight text-err">
            {t("empty", "kindCouldNotRead", { kind: resourceKind })}
          </h2>
        </div>
      )}
      {!isNotFound && (
        <Unknown
          // The heading already says "could not read this kind"; the box asks
          // the question the read was, so the same sentence is not stacked twice.
          question={t("empty", "whatIsThisKind", { kind: resourceKind })}
          error={error ?? t("empty", "clusterDidNotAnswer")}
        />
      )}
      {isNotFound && goneNote}
      {additionalMessage && (
        <p className="text-xs text-fg-mut">{additionalMessage}</p>
      )}
      <div className="flex items-center gap-1 pt-1">
        <DetailAction
          label={t("action", "goBack")}
          icon={ArrowLeft}
          onClick={onBack}
        />
        {isNotFound && onFindReplacement && (
          <DetailAction
            label={
              isSearching
                ? t("action", "searchingEllipsis")
                : t("action", "findReplacement")
            }
            icon={RefreshCw}
            onClick={onFindReplacement}
            busy={isSearching}
          />
        )}
      </div>
    </Section>
  );
}

interface ResourceDetailLayoutProps {
  resource: unknown;
  isLoading: boolean;
  error: Error | string | null;
  /** Kind, used for the breadcrumb and every "not found" message. */
  resourceKind: string;
  /**
   * Breadcrumb overrides for kinds the resource registry does not own, and
   * `null` for a kind with no list page to send the reader to.
   */
  listLink?: AppLink | null;
  listLabel?: string;

  /** The object's name. */
  title: string;
  namespace?: string;
  /** `null` where narrowing to the namespace has no list to open under it. */
  namespaceLink?: AppLink | null;
  createdAt?: string | null;
  statusBadge?: ReactNode;
  /** Qualifiers shown beside the name. */
  badges?: ReactNode;
  /**
   * The object, for the one question every detail page in the app is asked:
   * *where do I change this, and will my change stick.*
   *
   * Answered here rather than page by page, and that is the whole reason it is
   * a prop on the frame: provenance is not a property of workloads. A ConfigMap
   * is delivered from git exactly as much as a Deployment is, and a fact that
   * appeared on eleven detail pages and was missing on the twelfth would teach
   * the reader that its absence means "not delivered" — which on the twelfth
   * page would be a lie. A page passes the object and gets the mark, the earned
   * line and nothing else to think about.
   *
   * Omitted only where the page's subject is not an applied manifest at all.
   */
  delivery?: DeliveryQuery | null;
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
  /**
   * What this page adds to Share, from what it already read. Every detail
   * page gets Share from this frame; this is only the page's own part.
   */
  share?: (frame: ShareFrame) => ShareContribution;

  onBack: () => void;
  onFindReplacement?: () => void;
  isSearchingReplacement?: boolean;
  /** What else ended with the object, said under the gone notice. */
  goneNote?: ReactNode;

  /**
   * What is wrong with the object, in the two or three lines that say it.
   *
   * The only thing a page still puts above the strip, and the bar is high:
   * it is about the *object* rather than about the Overview, so it is worth
   * seeing while reading Conditions or a log, and it is worth the height it
   * takes from a full-height tab. A pod's problem summary qualifies; a
   * rollout in flight qualifies. A block does not — blocks are what the
   * Overview tab is, and there is no slot here for them any more.
   */
  summary?: ReactNode;

  /**
   * What the object's own query is worth right now, from `useResourceDetail`.
   *
   * Every detail page passes it and the header draws the same reading from it,
   * for the reason `delivery` is a prop on this frame too: a badge that is on
   * eleven pages and missing on the twelfth teaches the reader that the twelfth
   * is live, which is the one thing it must never be able to say by accident.
   */
  freshness?: Freshness;

  tabs: DetailTab[];
  activeTab: string;
  onTabChange: (tab: string) => void;
  onTabAgain?: (tab: string) => void;
  /** Where a kind the registry does not hold is served, for its owners. */
  served?: ServedResource | null;
}

/** What it owns, beside the page's own tabs and before its YAML. */
function withOwns(tabs: DetailTab[], owns: DetailTab): DetailTab[] {
  const yaml = tabs.findIndex((tab) => tab.id === "yaml");
  return yaml === -1
    ? [...tabs, owns]
    : [...tabs.slice(0, yaml), owns, ...tabs.slice(yaml)];
}

export function ResourceDetailLayout({
  resource,
  isLoading,
  error,
  resourceKind,
  listLink,
  listLabel,
  title,
  namespace,
  namespaceLink,
  createdAt,
  statusBadge,
  badges,
  delivery,
  actions,
  share,
  onBack,
  onFindReplacement,
  isSearchingReplacement,
  goneNote,
  summary,
  freshness,
  tabs: pageTabs,
  activeTab,
  onTabChange,
  onTabAgain,
  served,
}: ResourceDetailLayoutProps) {
  const t = useT();
  const lineage = useLineage(
    served ?? servedOfKind(resourceKind),
    title,
    namespace
  );
  const uid = lineage.data?.uid ?? null;
  useOwnershipKeys(served ?? servedOfKind(resourceKind), title, namespace);
  const tabs = useMemo(
    () =>
      uid
        ? withOwns(pageTabs, {
            id: "owns",
            label: t("owns", "tab"),
            glyph: viewGlyph(Network),
            content: <OwnsPanel uid={uid} namespace={namespace} />,
          })
        : pageTabs,
    [pageTabs, uid, namespace, t]
  );
  const { deliveries } = useDelivery(delivery ?? null);
  const owners = useLastOwners({ kind: resourceKind, name: title, namespace });
  const subject = useMemo(
    () =>
      resource
        ? { kind: resourceKind, name: title, namespace: namespace ?? null }
        : null,
    [resource, resourceKind, title, namespace]
  );

  // A page key (`l`, `y`, `e`, `o`) names a tab, and this frame is the one
  // thing every detail page renders through, so it answers for all of them:
  // a page without that tab simply does not move.
  useEffect(() => {
    const onOpen = (event: Event) => {
      const wanted = (event as CustomEvent<{ tab: string }>).detail?.tab;
      if (wanted && tabs.some((tab) => tab.id === wanted)) onTabChange(wanted);
    };
    window.addEventListener(DETAIL_TAB_OPEN, onOpen);
    return () => window.removeEventListener(DETAIL_TAB_OPEN, onOpen);
  }, [tabs, onTabChange]);

  // No object and no failure is a read still to come, as the peek draws it:
  // a read reset or called off sits there with nothing fetching.
  const reading = isLoading || (!resource && !error);

  // The banner belongs above these returns, not below them. An alert that
  // names an object this cluster does not have lands on exactly the error
  // page — the case the feature was built for — and the banner was mounted
  // underneath, so it never appeared there; `error` reaching it could only
  // ever be `undefined`, and its own "could not read" branch was dead code.
  const banner = (
    <>
      <AttachedFrom />
      <AlertBanner
        kind={resourceKind}
        name={title}
        namespace={namespace ?? null}
        now={resource && !error ? statusBadge : undefined}
        readAt={freshness?.dataUpdatedAt}
        error={error ? errorToShow(error) : undefined}
        reading={reading}
      />
    </>
  );

  if (reading) {
    return (
      <>
        {banner}
        <DetailSkeleton />
      </>
    );
  }

  if (error || !resource) {
    return (
      <>
        {banner}
        <DetailError
          error={error}
          resourceKind={resourceKind}
          namespace={namespace}
          owners={owners}
          onBack={onBack}
          onFindReplacement={onFindReplacement}
          isSearching={isSearchingReplacement}
          goneNote={goneNote}
        />
      </>
    );
  }

  // Which of the two the page's height belongs to: the flow, or the pane the
  // open tab is. Nothing above the strip is hidden for it — a banner earned by
  // this object is worth its two lines on a log as much as on the Overview,
  // and it is the tab's own content that grows into what is left.
  const surface = surfaceIsOpen(tabs, activeTab);

  return (
    <CaptionScope kind={resourceKind}>
      <div
        className={cn(
          // 12px rather than the page's 22px: what is left in this column is
          // chrome — identity, then the strip — and the mock's whole gain is
          // that the two read as one band. The 22px rhythm still belongs to
          // the blocks, which the open tab's panel now owns.
          "flex flex-col gap-3",
          surface && "h-full min-h-0"
        )}
      >
        <ResourceDetailHeader
          name={title}
          kind={resourceKind}
          served={served}
          listLink={listLink}
          listLabel={listLabel}
          namespace={namespace}
          namespaceLink={namespaceLink}
          createdAt={createdAt}
          status={statusBadge}
          meta={
            <>
              {badges}
              <DeliveryMarks deliveries={deliveries} />
              <HelmMark object={resource} />
            </>
          }
          onBack={onBack}
          dataUpdatedAt={freshness?.dataUpdatedAt}
          live={freshness?.live}
          slowed={freshness?.slowed}
          stale={freshness?.stale}
        />

        {/* Above the strip, and so on every tab: both say something about the
            object rather than about a view of it. Usually neither is there at
            all — the delivery line is earned per object, never per managed
            object, and a summary is what a healthy object does not have. */}
        <DeliveryBanner deliveries={deliveries} />
        {/* One mount for every kind that has a page. An alert names objects
            this app draws through six different components, and a banner
            copied into each is how five of them come to say something the
            sixth does not. */}
        {banner}
        {freshness?.stale && (
          <StaleRows
            object
            label={`${resourceKind} ${title}`}
            since={freshness.dataUpdatedAt}
            error={freshness.failure}
          />
        )}
        {summary}

        <DetailTabs
          tabs={tabs}
          activeTab={activeTab}
          onTabChange={onTabChange}
          onTabAgain={onTabAgain}
          subject={`${resourceKind}/${namespace ?? ""}/${title}`}
          actions={
            <>
              <ShareObjectAction
                subject={subject}
                resource={resource}
                contribute={share}
              />
              {actions}
            </>
          }
        />
      </div>
    </CaptionScope>
  );
}

export default ResourceDetailLayout;
