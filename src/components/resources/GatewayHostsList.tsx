/**
 * The hosts-first Gateway page: what this cluster serves, broken first.
 *
 * One row per attachment, keyed by what it serves — a hostname, or the
 * listener's port for the kinds that have none. The chain is the row:
 * gateway:listener → route → backends · ready, every hop the existing
 * peek-click. A stop is a sentence in the cluster's words with the repair
 * beside it, not a cell in a table. The object tables stay one link away
 * for the reader who came for an object.
 */

import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";

import { Skeleton } from "@/components/ui/skeleton";
import { ResourceRef } from "@/components/resources/ResourceRef";
import { gatewayHosts, type HostBackend, type HostRow } from "./gateway-hosts";
import { useGatewayRoutes } from "@/hooks/useGatewayRoutes";
import { useBackingLists } from "@/integrations";
import { commands } from "@/lib/commands";
import { useClusterStore } from "@/stores/clusterStore";
import { cn } from "@/lib/utils";

/** A minute: routing changes with a deploy, not by the second. */
const ROUTING_STALE = 60_000;

function Dot({ tone }: { tone: "ok" | "err" | "warn" | "mute" }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block h-[7px] w-[7px] flex-none rounded-full",
        tone === "ok" && "bg-ok",
        tone === "err" && "bg-err",
        tone === "warn" && "bg-warn",
        tone === "mute" && "bg-fg-fnt"
      )}
    />
  );
}

function Sep() {
  return (
    <span aria-hidden className="text-fg-fnt">
      →
    </span>
  );
}

function BackendHop({ backend, ns }: { backend: HostBackend; ns: string }) {
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className="rounded-[5px] bg-hover px-1.5">
        <ResourceRef
          kind="Service"
          name={backend.name}
          namespace={backend.namespace}
          showKind={false}
        />
        {backend.namespace !== ns && (
          <span className="text-fg-fnt"> · {backend.namespace}</span>
        )}
        {backend.weight !== null && (
          <span className="tabular-nums text-fg-fnt">
            {" "}
            {backend.weight === 0 ? "0 — drained" : backend.weight}
          </span>
        )}
      </span>
      {backend.stopTitle === null &&
        (backend.external ? (
          <span className="text-fg-fnt">· resolves elsewhere</span>
        ) : backend.ready !== null ? (
          <span className="tabular-nums text-ok">
            · {backend.ready} ready
            {backend.draining > 0 && `, ${backend.draining} draining`}
          </span>
        ) : null)}
    </span>
  );
}

function HostCard({
  row,
  tone,
}: {
  row: HostRow;
  tone: "ok" | "err" | "mute";
}) {
  return (
    <div className="mb-2 rounded-lg border border-hair bg-raise px-3 py-2">
      <div className="flex min-w-0 items-center gap-2.5">
        <Dot tone={tone} />
        <span className="truncate font-mono text-[13px] text-fg">
          {row.address}
        </span>
        <span className="ml-auto flex items-center gap-2 whitespace-nowrap text-[11px] text-fg-fnt">
          <span className="rounded-full border border-hair px-1.5">
            {row.kindTag}
          </span>
        </span>
      </div>
      <div className="mt-1.5 flex flex-wrap items-baseline gap-x-1.5 gap-y-1 pl-[17px] text-xs">
        {row.gateway && (
          <>
            <span
              className={cn(
                "rounded-[5px] px-1.5",
                row.gateway.exists ? "bg-hover" : "bg-hover opacity-90"
              )}
            >
              {row.gateway.exists ? (
                <ResourceRef
                  kind="Gateway"
                  name={row.gateway.name}
                  namespace={row.gateway.namespace}
                  showKind={false}
                />
              ) : (
                <span className="text-fg-mut">{row.gateway.name}</span>
              )}
              {row.gateway.listener && (
                <span className="font-mono text-fg-fnt">
                  {" "}
                  {row.gateway.listener}
                </span>
              )}
              {!row.gateway.exists && (
                <span className="text-err"> · missing</span>
              )}
            </span>
            <Sep />
          </>
        )}
        <span className="rounded-[5px] bg-hover px-1.5 outline outline-1 outline-hair">
          <ResourceRef
            kind={row.route.kind}
            name={row.route.name}
            namespace={row.route.namespace}
            showKind={false}
          />
        </span>
        {row.tail ? (
          <span className="text-fg-fnt">· {row.tail}</span>
        ) : (
          row.backends.map((backend, at) => (
            <span
              key={`${backend.namespace}/${backend.name}/${at}`}
              className="inline-flex items-baseline gap-1.5"
            >
              <Sep />
              <BackendHop backend={backend} ns={row.route.namespace} />
            </span>
          ))
        )}
      </div>
      {row.stop && (
        <p className="mb-0 mt-1.5 pl-[17px] text-xs text-err [text-wrap:pretty]">
          <b className="font-semibold">{row.stop.title}</b>
          {row.stop.fix && <span className="text-fg-mut"> {row.stop.fix}</span>}
        </p>
      )}
    </div>
  );
}

function GroupCap({
  children,
  count,
  tone,
  note,
}: {
  children: string;
  count?: number;
  tone?: "err";
  note?: string;
}) {
  return (
    <div className="mb-1.5 mt-5 flex items-baseline gap-2">
      <span
        className={cn(
          "text-[11px] font-semibold uppercase tracking-[0.06em]",
          tone === "err" ? "text-err" : "text-fg-fnt"
        )}
      >
        {children}
      </span>
      {count !== undefined && (
        <span className="tabular-nums text-[11px] text-fg-fnt">{count}</span>
      )}
      {note && <span className="text-[11px] text-fg-fnt">— {note}</span>}
    </div>
  );
}

export function GatewayHostsList() {
  const currentNamespace = useClusterStore((s) => s.currentNamespace);
  const { detection, served, routes, isLoading, error, live, resyncing } =
    useGatewayRoutes(currentNamespace);

  // Unscoped on purpose, twice over: routes attach to Gateways in other
  // namespaces, and the class claim is cluster-scoped.
  const gateways = useQuery({
    queryKey: ["gateway-hosts-gateways"],
    queryFn: () => commands.listGateways(null),
    staleTime: ROUTING_STALE,
    enabled: served.has("Gateway"),
  });
  const classes = useQuery({
    queryKey: ["gateway-classes"],
    queryFn: commands.listGatewayClasses,
    staleTime: ROUTING_STALE,
    enabled: served.has("GatewayClass"),
  });
  const backing = useBackingLists();

  const model = useMemo(
    () =>
      gatewayHosts(
        routes,
        gateways.data ?? [],
        classes.data ?? [],
        backing.data ? { ...backing.data, backingKnown: true } : undefined
      ),
    [routes, gateways.data, classes.data, backing.data]
  );

  if (detection && !detection.installed) {
    return (
      <div className="p-6">
        <h1 className="text-sm font-semibold text-fg">Gateway</h1>
        <p className="mt-2 max-w-[64ch] text-xs text-fg-fnt">
          This cluster does not serve the Gateway API kinds. Install the CRDs
          and a controller, and this page becomes the answer to "what does this
          cluster serve".
        </p>
      </div>
    );
  }

  if (isLoading || gateways.isLoading) {
    return (
      <div className="space-y-2 p-6">
        <Skeleton className="h-5 w-64" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <h1 className="text-sm font-semibold text-fg">Gateway</h1>
        <p className="mt-2 max-w-[64ch] text-xs text-err">
          The routes could not be read — what this cluster serves is not known,
          which is not the same as "nothing". {error.message}
        </p>
      </div>
    );
  }

  const empty =
    model.broken.length === 0 &&
    model.served.length === 0 &&
    model.ports.length === 0 &&
    model.quiet.length === 0;

  return (
    <div className="p-6">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="text-sm font-semibold text-fg">Gateway</h1>
        <span className="tabular-nums text-xs text-fg-fnt">
          {model.counts.served} served
          {model.counts.broken > 0 && (
            <>
              {" · "}
              <span className="text-err">
                {model.counts.broken} configured and dead
              </span>
            </>
          )}
          {resyncing && " · re-listing"}
          {!live && " · polling"}
        </span>
        <Link
          to="/network/routes/all"
          className="ml-auto text-xs text-fg-fnt underline-offset-2 hover:text-fg-mid hover:underline"
        >
          Browse as objects →
        </Link>
      </div>

      {(model.gateways.length > 0 || model.unclaimed.length > 0) && (
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-hair bg-raise px-3 py-2 text-xs">
          {model.gateways.map((g) => (
            <span
              key={`${g.namespace}/${g.name}`}
              className="flex items-center gap-1.5"
            >
              <Dot tone="ok" />
              <ResourceRef
                kind="Gateway"
                name={g.name}
                namespace={g.namespace}
                showKind={false}
              />
              <span className="text-fg-fnt">
                {g.address ?? "no address published"} · class {g.className}
              </span>
            </span>
          ))}
          {model.unclaimed.map((g) => (
            <span
              key={`${g.namespace}/${g.name}`}
              className="flex items-center gap-1.5"
            >
              <Dot tone="warn" />
              <ResourceRef
                kind="Gateway"
                name={g.name}
                namespace={g.namespace}
                showKind={false}
              />
              <span className="text-warn">
                no controller has claimed class {g.className}
              </span>
            </span>
          ))}
        </div>
      )}

      {empty && (
        <p className="mt-4 max-w-[64ch] text-xs text-fg-fnt">
          No routes in the current scope. The Gateways above answer, and every
          request meets whatever the controller serves for an unmatched host.
        </p>
      )}

      {model.broken.length > 0 && (
        <>
          <GroupCap tone="err" count={model.broken.length}>
            Not served
          </GroupCap>
          {model.broken.map((row) => (
            <HostCard key={row.key} row={row} tone="err" />
          ))}
        </>
      )}

      {model.served.length > 0 && (
        <>
          <GroupCap count={model.served.length}>Served</GroupCap>
          {model.served.map((row) => (
            <HostCard key={row.key} row={row} tone="ok" />
          ))}
        </>
      )}

      {model.ports.length > 0 && (
        <>
          <GroupCap
            count={model.ports.length}
            note="no hostname; the listener is the address"
          >
            Raw ports
          </GroupCap>
          {model.ports.map((row) => (
            <HostCard key={row.key} row={row} tone="ok" />
          ))}
        </>
      )}

      {model.quiet.length > 0 && (
        <>
          <GroupCap note="said, not hidden">Not drawn as traffic</GroupCap>
          {model.quiet.map((row) => (
            <HostCard key={row.key} row={row} tone="mute" />
          ))}
        </>
      )}
    </div>
  );
}
