import type { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { Link } from "react-router-dom";

import { DataFreshness, RealtimeAge } from "@/components/ui/realtime";
import { getResourceListUrl } from "@/lib/navigation-utils";
import { toPlural, type ResourceKind } from "@/lib/resource-registry";
import { formatDate } from "@/lib/utils";

export interface ResourceDetailHeaderProps {
  /** The object's own name — an identifier, so it reads as mono. */
  name: string;
  kind: ResourceKind | string;
  /**
   * Where the breadcrumb's kind segment points. Defaults to the registry's
   * list route, which is wrong for kinds the registry does not own: a Helm
   * release lists at `/helm`, and a custom resource's parent is its CRD.
   */
  listUrl?: string;
  /** The word in that segment, when the registry's plural is not it. */
  listLabel?: string;
  namespace?: string;
  /** The one badge that says whether this object is healthy. */
  status?: ReactNode;
  /** Facts that qualify the name: node roles, an ingress class, a count. */
  meta?: ReactNode;
  createdAt?: string | null;
  actions?: ReactNode;
  onBack: () => void;
  /** Timestamp of the last successful fetch, from React Query. */
  dataUpdatedAt?: number;
}

/**
 * The top of every detail page.
 *
 * The name used to be a 24px title with a 32px icon beside it, which made the
 * heaviest thing on the page the one fact the user just clicked to get here.
 * It is now breadcrumb-scale: the trail says where you are and gets you back
 * to the list, and the row below carries the name, its status, its age and the
 * actions — everything else belongs in the metadata blocks under it.
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
  actions,
  onBack,
  dataUpdatedAt,
}: ResourceDetailHeaderProps) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1 text-[11px] text-fg-fnt">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back"
          className="-ml-1 flex h-5 w-5 items-center justify-center rounded transition-colors hover:bg-hover hover:text-fg"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
        </button>
        <Link
          to={listUrl ?? getResourceListUrl(kind)}
          className="rounded px-1 py-0.5 transition-colors hover:bg-hover hover:text-fg"
        >
          {listLabel ?? toPlural(kind as ResourceKind)}
        </Link>
        {namespace && (
          <>
            <span aria-hidden="true">/</span>
            <span className="truncate font-mono">{namespace}</span>
          </>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <h1 className="truncate font-mono text-[13px] font-semibold tracking-tight text-fg">
          {name}
        </h1>
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
        <div className="ml-auto flex items-center gap-1">
          {actions}
          <DataFreshness dataUpdatedAt={dataUpdatedAt} />
        </div>
      </div>
    </div>
  );
}
