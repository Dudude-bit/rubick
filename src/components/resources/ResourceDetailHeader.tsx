import type { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { Link } from "react-router-dom";

import { DataFreshness, RealtimeAge } from "@/components/ui/realtime";
import { ResourceName } from "@/components/resources/ResourceName";
import {
  getResourceListUrl,
  toPlural,
  type ResourceKind,
} from "@/lib/resource-registry";
import { formatDate } from "@/lib/utils";

export interface ResourceDetailHeaderProps {
  /** The object's own name — an identifier, so it reads as mono. */
  name: string;
  kind: ResourceKind | string;
  /**
   * Where the breadcrumb's kind segment points. Defaults to the registry's
   * list route, which is wrong for kinds the registry does not own: a Helm
   * release lists at `/helm`, and a custom resource's parent is its CRD.
   *
   * `null` says there is nowhere to go, and the segment becomes plain text.
   * A ReplicaSet has a detail route and no list page on purpose, and a
   * breadcrumb reading `replicasets` that leads to a blank window is a worse
   * bug than the missing page it advertises.
   */
  listUrl?: string | null;
  /** The word in that segment, when the registry's plural is not it. */
  listLabel?: string;
  namespace?: string;
  /** The one badge that says whether this object is healthy. */
  status?: ReactNode;
  /** Facts that qualify the name: node roles, an ingress class, a count. */
  meta?: ReactNode;
  createdAt?: string | null;
  onBack: () => void;
  /** Timestamp of the last successful fetch, from React Query. */
  dataUpdatedAt?: number;
}

/**
 * The top of every detail page: one line, and only identity on it.
 *
 * The name used to be a 24px title with a 32px icon beside it, which made the
 * heaviest thing on the page the one fact the user just clicked to get here.
 * It then became two breadcrumb-scale rows — the trail on one, the name and
 * the page's actions on the other — above a page that already has a tab strip
 * of its own, so a detail page opened with two bands of chrome before the
 * first fact and a third one under them.
 *
 * The actions have moved to that strip, and once they are gone nothing is
 * left on the second row that will not fit on the first: the trail, the name,
 * its status, its qualifiers and its age are all breadcrumb-scale. One row
 * also means the header stops changing shape when the reader clicks Logs — it
 * used to collapse from two rows to one on a full-height tab, and a header
 * that restructures itself under the pointer reads as the page reloading.
 */
export function ResourceDetailHeader({
  name,
  kind,
  listUrl,
  listLabel,
  namespace,
  status,
  meta,
  createdAt,
  onBack,
  dataUpdatedAt,
}: ResourceDetailHeaderProps) {
  const segment = {
    to: listUrl === null ? null : (listUrl ?? getResourceListUrl(kind)),
    label: listLabel ?? toPlural(kind as ResourceKind),
  };

  const trail = (
    <>
      <button
        type="button"
        onClick={onBack}
        aria-label="Back"
        className="-ml-1 flex h-5 w-5 flex-none items-center justify-center rounded transition-colors hover:bg-hover hover:text-fg"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
      </button>
      {segment.to ? (
        <Link
          to={segment.to}
          className="flex-none rounded px-1 py-0.5 transition-colors hover:bg-hover hover:text-fg"
        >
          {segment.label}
        </Link>
      ) : (
        <span className="flex-none px-1 py-0.5">{segment.label}</span>
      )}
      {namespace && (
        <>
          <span aria-hidden="true">/</span>
          <span className="truncate font-mono">{namespace}</span>
        </>
      )}
    </>
  );

  // The same two marks every list gives this object — the kind glyph and the
  // identity tint — rather than a hand-rolled plain title. It is deliberately
  // not a `ResourceRef`: the reader is already here, and a link to the page
  // you are on is a promise the app cannot keep. The breadcrumb above already
  // names the kind, so only the glyph carries it.
  const title = (
    <h1 className="flex min-w-0 items-baseline gap-1.5 text-[13px] font-semibold tracking-tight text-fg">
      <ResourceName
        kind={kind}
        name={name}
        showKind={false}
        iconClassName="h-3 w-3"
      />
    </h1>
  );

  return (
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
      {/* Tighter than the row around it: the trail and the name are one path,
          and 10px between a slash and its segment breaks that path into
          separate words. */}
      <div className="flex min-w-0 items-center gap-x-1.5 text-[11px] text-fg-fnt">
        {trail}
        <span aria-hidden="true">/</span>
        {title}
      </div>
      {status}
      {meta}
      {createdAt && (
        <span
          className="text-[11px] text-fg-fnt"
          title={formatDate(createdAt) ?? undefined}
        >
          <RealtimeAge timestamp={createdAt} className="text-fg-fnt" /> old
        </span>
      )}
      <div className="ml-auto flex flex-none items-center">
        <DataFreshness dataUpdatedAt={dataUpdatedAt} />
      </div>
    </div>
  );
}
