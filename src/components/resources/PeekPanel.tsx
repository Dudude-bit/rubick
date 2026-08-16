import {
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { Link, useNavigate } from "react-router-dom";
import { useLiveQuery } from "@/hooks/useLiveQuery";

import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useRealtimeAge } from "@/hooks/useRealtimeAge";
import { useConnections } from "@/hooks/useConnections";
import { useProxyBehind, useServicesRoutes } from "@/hooks/useServiceRoutes";
import { CopyableAddress } from "@/components/ui/copyable-value";
import { Rail, routeAddress, RouteSource } from "./TrafficChain";
import { usePeek, type PeekTarget } from "@/hooks/usePeek";
import { commands } from "@/lib/commands";
import { cn } from "@/lib/utils";
import {
  getCustomResourceUrl,
  getResourceDetailUrl,
} from "@/lib/navigation-utils";
import type { ObjectRef } from "@/generated/types";
import { STALE_TIMES } from "@/lib/refresh";
import { EventRows } from "./detail-blocks";
import { KeyValueList } from "./detail-kv";
import { isRoutableKind, ResourceRef } from "./ResourceRef";
import { ResourceName, RESOURCE_NAME_SHELL } from "./ResourceName";
import { PeekActions } from "./PeekActions";
import { DeliveryMarks } from "./delivery";
import { useDelivery } from "@/hooks/useDelivery";
import { deliveryOfKind } from "@/lib/delivery";
import { toKind } from "@/lib/resource-registry";
import { resolveSource, type PeekSummary } from "./peek-sources";
import { peekTabsFor, resolvePeekTab, type PeekTabId } from "./peek-tabs";
import { PeekTabBody } from "./PeekTabs";
import { TabGlyph, TabMark } from "./tab-marks";
import { usePeekWidth } from "./peek-width";

/**
 * The right-hand drawer a reference opens.
 *
 * It answers "what is this object" without spending the page the reader is
 * already on, and — through its tabs — lets the object be worked on without
 * leaving that page either. Mounted once at the shell; everything it needs is
 * in `?peek=`, so a nested reference just rewrites that parameter and browser
 * back walks out of the peeks it opened.
 */
export function PeekPanel() {
  const { target, close } = usePeek();
  // Radix animates the close, and a panel that empties halfway through the
  // slide reads as a bug. Keep the last target on screen until it is gone.
  const [previous, setPrevious] = useState<PeekTarget | null>(target);
  if (target && target !== previous) setPrevious(target);
  const shown = target ?? previous;
  // The tab lives above the target, not inside it: clicking down a list of
  // pods with Logs open should stay on Logs rather than resetting each time.
  const [requestedTab, setRequestedTab] = useState<PeekTabId>("overview");

  return (
    // Not modal. A peek exists to be skimmed — click a row, glance, click the
    // next — and Radix's modal mode dims the app, makes it inert and traps
    // focus, so the sidebar, the scope tabs and the very list you are reading
    // all stop responding until you close it. That is a dialog, not a peek.
    <Sheet
      open={!!target}
      modal={false}
      onOpenChange={(next) => !next && close()}
    >
      {shown && (
        <PeekContent
          key={`${shown.kind}/${shown.namespace ?? ""}/${shown.name}`}
          target={shown}
          requestedTab={requestedTab}
          onTabChange={setRequestedTab}
        />
      )}
    </Sheet>
  );
}

function PeekContent({
  target,
  requestedTab,
  onTabChange,
}: {
  target: PeekTarget;
  requestedTab: PeekTabId;
  onTabChange: (tab: PeekTabId) => void;
}) {
  const navigate = useNavigate();
  const { close } = usePeek();
  const contentRef = useRef<HTMLDivElement>(null);
  const namespace = target.namespace ?? null;
  const { width, min, max, preview, commit } = usePeekWidth();

  const source = useMemo(() => resolveSource(target), [target]);

  const { data, error, isLoading } = useLiveQuery({
    // The CRD is part of the identity, not decoration: two groups may declare
    // the same kind, and a key without it would serve one of them from the
    // other's cache entry.
    queryKey: ["peek", target.crd ?? null, target.kind, namespace, target.name],
    queryFn: () => source.fetch(target.name, namespace),
    staleTime: STALE_TIMES.resourceDetail,
    refresh: "resourceDetail",
    refetchOnWindowFocus: false,
    retry: false,
  });

  // The Overview fetch is also what a tab is marked from, so the strip is
  // built after it rather than beside it.
  const tabs = useMemo(
    () => peekTabsFor(target.kind, data, target.crd),
    [target.kind, data, target.crd]
  );
  const activeTab = resolvePeekTab(requestedTab, tabs);

  const summary = useMemo(
    () => (data === undefined ? null : source.summarise(data, target)),
    [data, source, target]
  );

  const age = useRealtimeAge(summary?.createdAt ?? null);
  // "Where do I change this" is the same question in a preview as on the page,
  // and the answer is the same size — one small element beside the status.
  const { deliveries } = useDelivery(
    deliveryOfKind(
      toKind(target.kind) ?? target.kind,
      data as
        | {
            name: string;
            namespace?: string | null;
            labels?: Record<string, string>;
            annotations?: Record<string, string>;
          }
        | undefined
    )
  );
  // A custom resource has a page of its own too — the CRD's instance route —
  // so it gets the same Open full page and the same Enter shortcut.
  const routable = !!target.crd || isRoutableKind(target.kind, namespace);
  const openFullPage = () =>
    navigate(
      target.crd
        ? getCustomResourceUrl(target.crd, target.name, namespace)
        : getResourceDetailUrl(target.kind, target.name, namespace)
    );

  // Enter is the panel's shortcut, not the focused control's — once the
  // reader has tabbed onto a button, that button owns the key.
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" || !routable) return;
    if (event.target !== contentRef.current) return;
    event.preventDefault();
    openFullPage();
  };

  return (
    <SheetContent
      ref={contentRef}
      side="right"
      showOverlay={false}
      onKeyDown={handleKeyDown}
      // Without a scrim Radix would still close on any outside pointerdown,
      // including the one that picks the next row. Closing here and letting
      // that row's own click reopen the panel is a flicker for no gain; the
      // close affordances are the button, Escape and browser back.
      onPointerDownOutside={(event) => event.preventDefault()}
      onInteractOutside={(event) => event.preventDefault()}
      // Focus the panel itself rather than its close button, so Enter opens
      // the page and Escape closes without the reader aiming first.
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        contentRef.current?.focus();
      }}
      aria-describedby={undefined}
      style={{ width }}
      className="flex max-w-none flex-col gap-0 p-0 sm:max-w-none"
    >
      <PeekResizeHandle
        width={width}
        min={min}
        max={max}
        onPreview={preview}
        onCommit={commit}
      />

      <header className="flex-none px-3.5 pb-2 pt-3 pr-9">
        <SheetTitle className="flex min-w-0 items-center">
          <ResourceRef
            kind={target.kind}
            name={target.name}
            namespace={namespace}
            crd={target.crd}
            showKind={false}
            size="title"
            className="font-semibold"
          />
        </SheetTitle>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-fg-mut">
          {summary?.status && <StatusBadge status={summary.status} />}
          <span>{target.kind}</span>
          {namespace && (
            <>
              <span className="text-fg-fnt">·</span>
              <span>{namespace}</span>
            </>
          )}
          {(summary?.createdAt || summary?.age) && (
            <>
              <span className="text-fg-fnt">·</span>
              <span>{summary.createdAt ? `${age} old` : summary.age}</span>
            </>
          )}
          <DeliveryMarks deliveries={deliveries} />
        </div>
        <PeekActions
          target={target}
          detail={data}
          onOpenFullPage={routable ? openFullPage : undefined}
          onClose={close}
        />
      </header>

      <Tabs
        value={activeTab}
        onValueChange={(value) => onTabChange(value as PeekTabId)}
        className="flex min-h-0 flex-1 flex-col"
      >
        {/* Pills, still: this strip sits inside a panel over a page that has
            its own tab strip, and two underlines a hand apart would read as
            one control. The glyph rule composes with either shape. */}
        <TabsList className="flex h-8 w-full flex-none items-center justify-start gap-0.5 border-b border-hair px-2">
          {tabs.map((tab) => (
            <TabsTrigger
              key={tab.id}
              value={tab.id}
              className="group min-w-0"
              title={tab.mark ? `${tab.label} — ${tab.mark.of}` : undefined}
            >
              <TabGlyph glyph={tab.glyph} isActive={tab.id === activeTab} />
              <span className="truncate">{tab.label}</span>
              {tab.mark && (
                <TabMark mark={tab.mark} isActive={tab.id === activeTab} />
              )}
            </TabsTrigger>
          ))}
        </TabsList>

        {tabs.map((tab) => (
          <TabsContent
            key={tab.id}
            value={tab.id}
            className="mt-0 min-h-0 flex-1 overflow-hidden"
          >
            {tab.id === "overview" ? (
              <PeekOverview
                target={target}
                summary={summary}
                error={error}
                isLoading={isLoading}
              />
            ) : (
              <PeekTabBody
                tab={tab.id}
                target={target}
                detail={data}
                isDetailLoading={isLoading}
              />
            )}
          </TabsContent>
        ))}
      </Tabs>
    </SheetContent>
  );
}

/**
 * The drag handle on the panel's left edge.
 *
 * Focusable and arrow-driven as well as draggable: a 6px strip that only
 * answers to a pointer is not a control anyone without a mouse can reach.
 */
function PeekResizeHandle({
  width,
  min,
  max,
  onPreview,
  onCommit,
}: {
  width: number;
  min: number;
  max: number;
  onPreview: (width: number) => void;
  onCommit: (width: number) => void;
}) {
  const drag = useRef<{ pointerX: number; width: number } | null>(null);

  const widthAt = (event: ReactPointerEvent<HTMLDivElement>) =>
    // The panel is anchored right, so dragging left widens it.
    drag.current
      ? drag.current.width + (drag.current.pointerX - event.clientX)
      : width;

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 64 : 16;
    if (event.key === "ArrowLeft") onCommit(width + step);
    else if (event.key === "ArrowRight") onCommit(width - step);
    // The edge, not the width: Home puts it as far left as it goes.
    else if (event.key === "Home") onCommit(max);
    else if (event.key === "End") onCommit(min);
    else return;
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Panel width"
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      data-testid="peek-resize-handle"
      onPointerDown={(event) => {
        drag.current = { pointerX: event.clientX, width };
        event.currentTarget.setPointerCapture(event.pointerId);
        // Keeps the drag from selecting the text behind it; focus has to be
        // asked for explicitly once the default is gone.
        event.preventDefault();
        event.currentTarget.focus();
      }}
      onPointerMove={(event) => {
        if (drag.current) onPreview(widthAt(event));
      }}
      onPointerUp={(event) => {
        if (!drag.current) return;
        const next = widthAt(event);
        drag.current = null;
        event.currentTarget.releasePointerCapture(event.pointerId);
        onCommit(next);
      }}
      onKeyDown={handleKeyDown}
      className="absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize hover:bg-sel focus-visible:bg-info focus-visible:outline-hidden"
    />
  );
}

function PeekOverview({
  target,
  summary,
  error,
  isLoading,
}: {
  target: PeekTarget;
  summary: PeekSummary | null;
  error: Error | null;
  isLoading: boolean;
}) {
  return (
    <div className="h-full overflow-y-auto scrollbar-thin px-3.5 pb-5">
      {error ? (
        <p className="pt-4 text-xs text-warn">
          Could not read this {target.kind.toLowerCase()}: {error.message}
        </p>
      ) : isLoading || !summary ? (
        <PeekSkeleton />
      ) : (
        summary.groups.map((group) => (
          <div key={group.title}>
            <PeekHeading title={group.title} count={group.count} />
            <KeyValueList
              items={group.items}
              emptyMessage={group.emptyMessage ?? "None"}
            />
          </div>
        ))
      )}
      {TRAFFIC_KINDS.has(target.kind) && <PeekTraffic target={target} />}
      <PeekEvents target={target} />
    </div>
  );
}

/** The kinds a request travels through, each owed its up and its down. */
const TRAFFIC_KINDS = new Set([
  "Service",
  "Endpoints",
  "Pod",
  "Deployment",
  "StatefulSet",
  "DaemonSet",
  "ReplicaSet",
  "Job",
  "CronJob",
]);

/**
 * The level above and the level below, so a peek is a place to walk the
 * chain from rather than a dead end. An Endpoints names its Service, a
 * Service names its Endpoints and every way traffic reaches it from
 * outside, a Pod and a workload name the Services in front of them — and
 * every name is a peek of its own, so the tangle unwinds hop by hop
 * without leaving the panel. Ownership already walks through Controlled
 * by; this is the traffic direction.
 *
 * Drawn as one chain on the detail pages' rail, the peeked object mid-rope:
 * what is above it is how traffic arrives, what is below is what answers.
 * Two flat headings used to say that order in words, and read as prose.
 */
function PeekTraffic({ target }: { target: PeekTarget }) {
  const namespace = target.namespace ?? "";
  const service = { namespace, name: target.name };
  const isServiceish = target.kind === "Service" || target.kind === "Endpoints";

  // The core's own edges and the vendors' routes, cached by the same keys
  // their pages use. A Service and its Endpoints share a name by contract,
  // which is what lets the Endpoints panel ask about its Service.
  const conns = useConnections(
    isServiceish ? "Service" : target.kind,
    target.name,
    namespace
  );
  const behind = useProxyBehind(target.kind === "Service" ? service : null);

  const edges = conns.data?.edges ?? [];
  // An Ingress hop keeps the hosts its rules name, so the hop says which
  // door it is rather than only that a door exists.
  const ingresses = new Map<string, { object: ObjectRef; hosts: string[] }>();
  for (const edge of edges) {
    if (edge.relation.verb !== "routes" || edge.from.kind !== "Ingress")
      continue;
    const key = `${edge.from.namespace}/${edge.from.name}`;
    const entry = ingresses.get(key) ?? { object: edge.from, hosts: [] };
    if (edge.relation.host && !entry.hosts.includes(edge.relation.host)) {
      entry.hosts.push(edge.relation.host);
    }
    ingresses.set(key, entry);
  }
  // For a Pod or a workload, the level above is whichever Services stand in
  // front of it — the graph names them from either end of an edge.
  const services = isServiceish
    ? []
    : [
        ...new Map(
          edges
            .flatMap((edge) => [edge.from, edge.to])
            .filter((object) => object.kind === "Service")
            .map((object) => [`${object.namespace}/${object.name}`, object])
        ).values(),
      ];

  // The vendors are asked about the peeked Service itself — or, from a Pod
  // or a workload, about the Services in front of it: an IngressRoute over
  // that Service is this pod's way in just the same, and without this the
  // Service drew as the top of the world.
  const routed = useServicesRoutes(
    isServiceish
      ? [service]
      : services.map((entry) => ({
          namespace: entry.namespace ?? "",
          name: entry.name,
        }))
  );
  const vendorRoutes = [
    ...new Map(
      (isServiceish ? [service] : services)
        .flatMap(
          (entry) =>
            routed.routes.get(`${entry.namespace ?? ""}/${entry.name}`) ?? []
        )
        .filter((route) => route.source.kind !== "Ingress")
        .map((route) => [`${route.host}${route.path}`, route] as const)
    ).values(),
  ];

  // One dot per LEVEL of the path, not per object: two routes to one
  // Service are two doors on one level, and drawing them in sequence read
  // as one hostname flowing into the other. Within a level the entries
  // stack; the arrows run between levels only.
  const shownRoutes = vendorRoutes.slice(0, 6);
  const waysIn: ReactNode[] = [
    ...[...ingresses.values()].map(({ object, hosts }) => (
      <p
        key={`ingress/${object.namespace}/${object.name}`}
        className="text-[11px] text-fg-fnt"
      >
        <ResourceRef
          kind="Ingress"
          name={object.name}
          namespace={object.namespace}
          showKind={false}
        />{" "}
        {hosts.length > 0 && (
          <span className="font-mono text-xs text-fg-mid">
            {hosts.join(", ")}{" "}
          </span>
        )}
        — Ingress
      </p>
    )),
    // Object first and the address under it, the order every other entry
    // reads in — this line is the router, not its hostname.
    ...shownRoutes.map((route) => (
      <div key={`route/${route.host}${route.path}`}>
        <p className="text-[11px] text-fg-fnt">
          <RouteSource route={route} /> — {route.source.kind}
        </p>
        <p className="text-[11px] text-fg-fnt">
          <CopyableAddress value={routeAddress(route)} label="Address" />
          {route.h2c ? " (gRPC)" : ""}
        </p>
      </div>
    )),
    ...(vendorRoutes.length > shownRoutes.length
      ? [
          <p key="more" className="text-[11px] text-fg-fnt">
            and {vendorRoutes.length - shownRoutes.length} more
          </p>,
        ]
      : []),
  ];

  const levels: { key: string; entries: ReactNode[] }[] = [];
  if (waysIn.length > 0) levels.push({ key: "ways-in", entries: waysIn });
  if (services.length > 0) {
    levels.push({
      key: "in-front",
      entries: services.map((entry) => (
        <p
          key={`${entry.namespace}/${entry.name}`}
          className="text-[11px] text-fg-fnt"
        >
          <ResourceRef
            kind="Service"
            name={entry.name}
            namespace={entry.namespace}
            showKind={false}
          />{" "}
          — the Service in front
        </p>
      )),
    });
  }
  if (target.kind === "Endpoints") {
    levels.push({
      key: "publishes",
      entries: [
        <p key="publishes" className="text-[11px] text-fg-fnt">
          <ResourceRef
            kind="Service"
            name={target.name}
            namespace={namespace}
            showKind={false}
          />{" "}
          — the Service these endpoints publish
        </p>,
      ],
    });
  }
  levels.push({
    key: "self",
    entries: [
      <p key="self" className="text-[11px] text-fg-fnt">
        {/* The selection tint the app already means "current" by. */}
        <span className={cn(RESOURCE_NAME_SHELL, "bg-sel")}>
          <ResourceName
            kind={target.kind}
            name={target.name}
            showKind={false}
          />
        </span>{" "}
        — this {target.kind}
      </p>,
    ],
  });
  if (target.kind === "Service") {
    levels.push({
      key: "behind",
      entries: [
        <p key="endpoints" className="text-[11px] text-fg-fnt">
          <ResourceRef
            kind="Endpoints"
            name={target.name}
            namespace={namespace}
            showKind={false}
          />{" "}
          — the addresses actually answering, pod by pod
        </p>,
        ...(behind
          ? [
              <p key="proxy" className="text-[11px] text-fg-fnt">
                {behind.vendor}&rsquo;s own proxy — the {behind.hosts} host
                {behind.hosts === 1 ? "" : "s"} it serves are on{" "}
                <Link
                  to={behind.to}
                  className="text-info underline-offset-2 hover:underline"
                >
                  its page
                </Link>
              </p>,
            ]
          : []),
      ],
    });
  }

  // The object alone is not a chain; a Pod nothing routes stays quiet.
  if (levels.length === 1) return null;

  return (
    <div>
      <PeekHeading title="Traffic path" />
      <div className="pb-1">
        {levels.map((level, index) => {
          const last = index === levels.length - 1;
          return (
            <div
              key={level.key}
              className="grid grid-cols-[7px_minmax(0,1fr)] gap-x-2.5"
            >
              <Rail
                tone="on"
                into={last ? null : "on"}
                entering={index > 0}
                here={level.key === "self"}
              />
              <div
                className={cn("flex min-w-0 flex-col gap-1", !last && "pb-2")}
              >
                {level.entries}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PeekHeading({ title, count }: { title: string; count?: ReactNode }) {
  return (
    <h3 className="flex items-baseline gap-1.5 pb-1 pt-4 text-[11px] font-semibold text-fg">
      {title}
      {count != null && (
        <span className="font-normal text-fg-fnt">{count}</span>
      )}
    </h3>
  );
}

/**
 * The overview's own shape while it loads: grouped key/value runs under
 * heading-sized bars, labels short and values uneven — the way the real
 * groups read. Five identical full-width rows promised a different screen,
 * and the swap to content was a jolt instead of a fill-in.
 */
const SKELETON_LABELS = ["w-10", "w-16", "w-12", "w-20"];
const SKELETON_VALUES = ["w-24", "w-40", "w-16", "w-32"];

function PeekSkeleton() {
  return (
    <div aria-hidden="true" data-testid="peek-skeleton">
      {[4, 3].map((rows, group) => (
        <div key={group}>
          <div className="flex items-center pb-1 pt-4">
            <Skeleton className="h-2.5 w-24" />
          </div>
          {Array.from({ length: rows }).map((_, index) => (
            <div
              key={index}
              className="grid grid-cols-[minmax(0,132px)_minmax(0,1fr)] items-baseline gap-3 border-b border-hair py-[7px]"
            >
              <Skeleton
                className={cn(
                  "h-2.5",
                  SKELETON_LABELS[(group + index) % SKELETON_LABELS.length]
                )}
              />
              <Skeleton
                className={cn(
                  "h-2.5",
                  SKELETON_VALUES[(group * 2 + index) % SKELETON_VALUES.length]
                )}
              />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function PeekEvents({ target }: { target: PeekTarget }) {
  const { data: events, error } = useLiveQuery({
    queryKey: [
      "peek-events",
      target.kind,
      target.namespace ?? null,
      target.name,
    ],
    queryFn: () =>
      commands.listEvents({
        namespace: target.namespace ?? null,
        involved_object_name: target.name,
        involved_object_kind: target.kind,
        event_type: null,
        field_selector: null,
        limit: 20,
      }),
    staleTime: STALE_TIMES.fast,
    refresh: "overview",
    refetchOnWindowFocus: false,
    retry: false,
  });

  return (
    <>
      <PeekHeading title="Recent events" count={events?.length || undefined} />
      {error ? (
        <p className="py-1 text-xs text-warn">Could not read events.</p>
      ) : !events ? (
        <Skeleton className="h-3 w-2/3" />
      ) : (
        <EventRows
          events={events}
          emptyMessage="No events for this object"
          compact
        />
      )}
    </>
  );
}
