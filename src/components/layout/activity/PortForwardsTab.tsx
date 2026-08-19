import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  Loader2,
  MoreHorizontal,
  Network,
  Pencil,
  Play,
  Plus,
  Square,
  Trash2,
} from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/components/ui/use-toast";
import { PortForwardConfigDialog } from "@/components/port-forward/PortForwardConfigDialog";
import { ResourceRef } from "@/components/resources/ResourceRef";
import { ResourceType } from "@/lib/resource-registry";
import { normalizeTauriError } from "@/lib/error-utils";
import { useClusterStore } from "@/stores/clusterStore";
import {
  usePortForwardStore,
  type PortForwardConfig,
  type PortForwardSession,
  type PortForwardStatus,
} from "@/stores/portForwardStore";
import { cn } from "@/lib/utils";
import {
  ACTIVITY_ROW,
  ActivityAction,
  ActivityEmpty,
  ActivityGroup,
} from "./primitives";
import { useT } from "@/i18n/useT";

/** Same shape the store keys sessions by; do not reorder the parts. */
const forwardKey = (item: {
  context: string;
  pod: string;
  namespace: string;
  localPort: number;
  remotePort: number;
}) =>
  `${item.context}:${item.pod}:${item.namespace}:${item.localPort}:${item.remotePort}`;

/** `undefined` is closed, `null` is the new-config form. */
type Editing = PortForwardConfig | null | undefined;

/**
 * One running forward.
 *
 * `namesCluster` follows the scope-tab rule: the cluster's name is spent
 * only where it discriminates. Inside the current context every row shares
 * it and the panel header has just said it; in the elsewhere group it is the
 * whole point of the row. The pod stops being a link there too — the route
 * would resolve against the cluster the reader is in, which is a different
 * pod with the same name, or none.
 */
function SessionRow({
  session,
  status,
  isBusy,
  onStop,
  namesCluster = false,
}: {
  session: PortForwardSession;
  status: PortForwardStatus | undefined;
  isBusy: boolean;
  onStop: () => void;
  namesCluster?: boolean;
}) {
  const t = useT();
  const isError = status?.status === "error";
  const isReconnecting =
    status?.status === "reconnecting" || status?.status === "reconnected";

  return (
    <div className={ACTIVITY_ROW}>
      <span
        aria-hidden="true"
        className={cn(
          "h-1.5 w-1.5 flex-none rounded-full",
          isError ? "bg-err" : isReconnecting ? "bg-warn" : "bg-ok"
        )}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate">
          {/* The panel's whole job is telling you what is running and against
              what; the target was the one thing in it you could not get to. */}
          {namesCluster ? (
            session.pod
          ) : (
            <ResourceRef
              kind={ResourceType.Pod}
              name={session.pod}
              namespace={session.namespace}
              showKind={false}
            />
          )}
        </span>
        <span className="block truncate font-mono text-[11px] text-fg-fnt">
          {namesCluster && `${session.context} · `}
          {session.namespace} · :{session.localPort} → :{session.remotePort}
          {isError && " · failed"}
          {isReconnecting && " · reconnecting"}
        </span>
      </span>
      <ActivityAction
        aria-label={t("activity", "stopForwarding", { pod: session.pod })}
        onClick={onStop}
        disabled={isBusy}
      >
        {isBusy ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Square className="h-3.5 w-3.5" />
        )}
      </ActivityAction>
    </div>
  );
}

/**
 * Everything about a port forward, in the panel that owns running things.
 *
 * Settings used to keep a second copy of this list — the same forward with
 * two homes that could disagree, one of them on a page about preferences.
 * A forward is a process, so the list lives here, and the editing that
 * only the Settings copy could do came with it.
 */
export function PortForwardsTab() {
  const t = useT();
  const { toast } = useToast();
  const currentContext = useClusterStore((state) => state.currentContext);
  const configs = usePortForwardStore((state) => state.configs);
  const sessions = usePortForwardStore((state) => state.sessions);
  const statusBySession = usePortForwardStore((state) => state.statusBySession);
  const configsLoaded = usePortForwardStore((state) => state.configsLoaded);
  const refreshConfigs = usePortForwardStore((state) => state.refreshConfigs);
  const startConfig = usePortForwardStore((state) => state.startConfig);
  const stopSession = usePortForwardStore((state) => state.stopSession);
  const removeConfig = usePortForwardStore((state) => state.removeConfig);
  const startAllForContext = usePortForwardStore(
    (state) => state.startAllForContext
  );

  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<Editing>(undefined);
  const [startingAll, setStartingAll] = useState(false);

  useEffect(() => {
    if (configsLoaded) return;
    refreshConfigs().catch((error) => {
      console.error("Failed to load port-forward configs:", error);
    });
  }, [configsLoaded, refreshConfigs]);

  const contextConfigs = useMemo(
    () => configs.filter((config) => config.context === currentContext),
    [configs, currentContext]
  );

  const sessionByKey = useMemo(
    () => new Map(sessions.map((session) => [forwardKey(session), session])),
    [sessions]
  );

  // A forward is a process, and one started against another cluster is still
  // running and still holding a local port — deleting it from the list would
  // be the panel lying about what is on the machine. So it is separated
  // rather than dropped, the way the scope tabs name a cluster only where
  // the name is what tells two rows apart.
  const [contextSessions, otherSessions] = useMemo(
    () => [
      sessions.filter((session) => session.context === currentContext),
      sessions.filter((session) => session.context !== currentContext),
    ],
    [sessions, currentContext]
  );

  const idleCount = useMemo(
    () =>
      contextConfigs.filter((config) => !sessionByKey.has(forwardKey(config)))
        .length,
    [contextConfigs, sessionByKey]
  );

  const withBusy = async (id: string, run: () => Promise<unknown>) => {
    setBusyIds((prev) => new Set(prev).add(id));
    try {
      await run();
    } finally {
      setBusyIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const handleStart = (configId: string) =>
    withBusy(configId, async () => {
      try {
        await startConfig(configId);
      } catch (error) {
        toast({
          title: t("activity", "startForwardFailed"),
          description: normalizeTauriError(error),
          variant: "destructive",
        });
      }
    });

  const handleStop = (sessionId: string) =>
    withBusy(sessionId, async () => {
      try {
        await stopSession(sessionId);
      } catch (error) {
        toast({
          title: t("activity", "stopForwardFailed"),
          description: normalizeTauriError(error),
          variant: "destructive",
        });
      }
    });

  const handleDelete = (config: PortForwardConfig) =>
    withBusy(config.id, async () => {
      try {
        await removeConfig(config.id);
      } catch (error) {
        toast({
          title: t("activity", "deleteForwardFailed"),
          description: normalizeTauriError(error),
          variant: "destructive",
        });
      }
    });

  const handleStartAll = async () => {
    if (!currentContext) return;
    setStartingAll(true);
    try {
      const result = await startAllForContext(currentContext);
      toast({
        title: t("activity", "startedForwards"),
        description: t("activity", "startedForwardsDetail", {
          started: result.started,
          skipped: result.skipped,
          failed: result.failed,
        }),
      });
    } catch (error) {
      toast({
        title: t("activity", "startAllFailed"),
        description: normalizeTauriError(error),
        variant: "destructive",
      });
    } finally {
      setStartingAll(false);
    }
  };

  if (!currentContext) {
    return (
      <ActivityEmpty
        icon={AlertCircle}
        title={t("activity", "connectToManageForwards")}
      />
    );
  }

  if (!configsLoaded) {
    return (
      <div className="flex items-center justify-center py-10">
        <Loader2 className="h-4 w-4 animate-spin text-fg-fnt" />
      </div>
    );
  }

  return (
    <div className="pb-3">
      {contextSessions.length > 0 && (
        <ActivityGroup title="Running" count={contextSessions.length}>
          {contextSessions.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              status={statusBySession[session.id]}
              isBusy={busyIds.has(session.id)}
              onStop={() => handleStop(session.id)}
            />
          ))}
        </ActivityGroup>
      )}

      {otherSessions.length > 0 && (
        <ActivityGroup title="Running elsewhere" count={otherSessions.length}>
          {otherSessions.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              status={statusBySession[session.id]}
              isBusy={busyIds.has(session.id)}
              onStop={() => handleStop(session.id)}
              namesCluster
            />
          ))}
        </ActivityGroup>
      )}

      <ActivityGroup
        title={t("activity", "saved")}
        count={contextConfigs.length}
        action={
          <span className="flex items-center gap-0.5">
            {idleCount > 1 && (
              <ActivityAction onClick={handleStartAll} disabled={startingAll}>
                <Play className="h-3 w-3" />
                {startingAll
                  ? t("action", "starting")
                  : t("activity", "startAll")}
              </ActivityAction>
            )}
            <ActivityAction onClick={() => setEditing(null)}>
              <Plus className="h-3 w-3" />
              {t("activity", "new")}
            </ActivityAction>
          </span>
        }
      >
        {contextConfigs.length === 0 ? (
          // Saved configs are filtered to the current context, so a forward
          // saved against another cluster is not gone — it is just not here,
          // and "none saved" said otherwise. The New button is a foot away
          // in this group's own header, so the hint spends its words on the
          // scope instead of naming it again.
          <ActivityEmpty
            icon={Network}
            title={t("activity", "noForwardsSaved", {
              context: currentContext,
            })}
            hint={
              configs.length > 0
                ? t("activity", "forwardsSavedElsewhere", { n: configs.length })
                : t("activity", "forwardSavedHint")
            }
          />
        ) : (
          contextConfigs.map((config) => {
            const activeSession = sessionByKey.get(forwardKey(config));
            const isBusy = busyIds.has(config.id);

            return (
              <div key={config.id} className={ACTIVITY_ROW}>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-fg-mid">
                    {config.name}
                    {config.autoStart && (
                      <span className="ml-1.5 text-[11px] text-fg-fnt">
                        {t("activity", "autoStart")}
                      </span>
                    )}
                  </span>
                  <span className="block truncate font-mono text-[11px] text-fg-fnt">
                    <ResourceRef
                      kind={ResourceType.Pod}
                      name={config.pod}
                      namespace={config.namespace}
                      showKind={false}
                    />{" "}
                    · :{config.localPort} → :{config.remotePort}
                  </span>
                </span>
                <ActivityAction
                  aria-label={
                    activeSession
                      ? t("activity", "stopNamed", { name: config.name })
                      : t("activity", "startNamed", { name: config.name })
                  }
                  onClick={() =>
                    activeSession
                      ? handleStop(activeSession.id)
                      : handleStart(config.id)
                  }
                  disabled={isBusy}
                >
                  {isBusy ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : activeSession ? (
                    <Square className="h-3.5 w-3.5" />
                  ) : (
                    <Play className="h-3.5 w-3.5" />
                  )}
                </ActivityAction>
                {/* Editing and deleting are rare next to start and stop, so
                    they sit behind one affordance instead of widening every
                    row by two buttons. */}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <ActivityAction
                      aria-label={t("activity", "moreActionsFor", {
                        name: config.name,
                      })}
                    >
                      <MoreHorizontal className="h-3.5 w-3.5" />
                    </ActivityAction>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => setEditing(config)}>
                      <Pencil className="mr-2 h-3.5 w-3.5" />
                      {t("action", "edit")}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      className="text-err"
                      onSelect={() => handleDelete(config)}
                    >
                      <Trash2 className="mr-2 h-3.5 w-3.5" />
                      {t("action", "delete")}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            );
          })
        )}
      </ActivityGroup>

      {editing !== undefined && (
        <PortForwardConfigDialog
          context={currentContext}
          config={editing ?? undefined}
          onClose={() => setEditing(undefined)}
        />
      )}
    </div>
  );
}
