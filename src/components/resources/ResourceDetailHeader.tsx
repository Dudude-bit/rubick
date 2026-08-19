import type { MouseEvent, ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";

import { DataFreshness, RealtimeAge } from "@/components/ui/realtime";
import { ResourceName } from "@/components/resources/ResourceName";
import { useLinkGesture } from "@/hooks/useLinkGesture";
import {
  getResourceListUrl,
  toPlural,
  type ResourceKind,
} from "@/lib/resource-registry";
import { formatDate } from "@/lib/utils";
import { useClusterStore } from "@/stores/clusterStore";
import { useT } from "@/i18n/useT";

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
  /**
   * The list the namespace segment narrows. Defaults to wherever the kind
   * segment points, which is that list for every kind whose parent is one.
   *
   * `null` for the kinds where it is not: a ReplicaSet's parent is a
   * Deployment, and Helm's list carries a namespace filter of its own that
   * this scope does not drive. Narrowing the tab is then all the segment can
   * honestly offer, so it does that and stays where it is.
   */
  namespaceUrl?: string | null;
  /** The one badge that says whether this object is healthy. */
  status?: ReactNode;
  /** Facts that qualify the name: node roles, an ingress class, a count. */
  meta?: ReactNode;
  createdAt?: string | null;
  onBack: () => void;
  /** Timestamp of the last successful fetch, from React Query. */
  dataUpdatedAt?: number;
  /** Polled, and backed off past its rate because nothing is changing. */
  slowed?: boolean;
}

/** Both segments of the trail, so the reader's eye reads one path. */
const SEGMENT =
  "rounded px-1 py-0.5 transition-colors hover:bg-hover hover:text-fg";

/**
 * The namespace in the trail, and the scope it stands for.
 *
 * `pods / k8s-gui-test / burst-demo` reads as a path, so the middle of it has
 * to behave like one. It means "that list, in this namespace": the tab is
 * narrowed to the namespace and the list opens under it. Narrowing is a side
 * effect past navigation — the scope pill in the tab strip changes with it —
 * so the segment says so instead of only naming itself, and says it only
 * while it is true.
 *
 * With no list to narrow the scope is all there is to offer, and the segment
 * hands it over without leaving the page: a detail page stays valid under its
 * own object's namespace, so nothing the reader is looking at goes away.
 * Once the tab already holds that scope there is nothing left to do at all,
 * and the segment is text rather than a control that answers a click with
 * nothing — which is the bug it exists to fix.
 */
function NamespaceSegment({
  namespace,
  to,
  label,
}: {
  namespace: string;
  to: string | null;
  label: string;
}) {
  const t = useT();
  const navigate = useNavigate();
  const scope = useClusterStore((state) => state.currentNamespace);
  const switchNamespace = useClusterStore((state) => state.switchNamespace);
  const gesture = useLinkGesture();

  const narrows = scope !== namespace;
  const narrow = () => {
    if (narrows) void switchNamespace(namespace);
  };

  if (to) {
    const says = narrows
      ? t("action", "showInNamespaceNarrows", { label, namespace })
      : t("action", "showInNamespace", { label, namespace });
    const handle = (event: MouseEvent<HTMLAnchorElement>) =>
      gesture(
        event,
        to,
        () => {
          narrow();
          navigate(to);
        },
        namespace
      );
    return (
      <Link
        to={to}
        title={says}
        aria-label={says}
        onClick={handle}
        onAuxClick={handle}
        className={`${SEGMENT} truncate font-mono`}
      >
        {namespace}
      </Link>
    );
  }

  if (!narrows)
    return <span className="truncate px-1 py-0.5 font-mono">{namespace}</span>;

  const says = t("action", "scopeTabTo", { namespace });
  // The new tab a modified gesture opens has no list to land on either, so it
  // starts where a new tab always starts — the overview, under this scope.
  const handle = (event: MouseEvent<HTMLButtonElement>) =>
    gesture(event, "/", narrow, namespace);
  return (
    <button
      type="button"
      title={says}
      aria-label={says}
      onClick={handle}
      onAuxClick={handle}
      className={`${SEGMENT} truncate font-mono`}
    >
      {namespace}
    </button>
  );
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
  namespaceUrl,
  status,
  meta,
  createdAt,
  onBack,
  dataUpdatedAt,
  slowed,
}: ResourceDetailHeaderProps) {
  const t = useT();
  const segment = {
    to: listUrl === null ? null : (listUrl ?? getResourceListUrl(kind)),
    label: listLabel ?? toPlural(kind as ResourceKind),
  };

  const trail = (
    <>
      <button
        type="button"
        onClick={onBack}
        aria-label={t("action", "back")}
        className="-ml-1 flex h-5 w-5 flex-none items-center justify-center rounded transition-colors hover:bg-hover hover:text-fg"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
      </button>
      {segment.to ? (
        <Link to={segment.to} className={`${SEGMENT} flex-none`}>
          {segment.label}
        </Link>
      ) : (
        <span className="flex-none px-1 py-0.5">{segment.label}</span>
      )}
      {namespace && (
        <>
          <span aria-hidden="true">/</span>
          <NamespaceSegment
            namespace={namespace}
            to={namespaceUrl === undefined ? segment.to : namespaceUrl}
            label={segment.label}
          />
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
    <h1 className="flex min-w-0 items-baseline gap-1.5 font-semibold tracking-tight text-fg">
      <ResourceName
        kind={kind}
        name={name}
        showKind={false}
        size="title"
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
          <RealtimeAge timestamp={createdAt} className="text-fg-fnt" />{" "}
          {t("action", "ageOldSuffix")}
        </span>
      )}
      <div className="ml-auto flex flex-none items-center">
        <DataFreshness dataUpdatedAt={dataUpdatedAt} slowed={slowed} />
      </div>
    </div>
  );
}
