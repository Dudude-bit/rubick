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
} from "@/stores/portForwardStore";
import { cn } from "@/lib/utils";
import {
  ACTIVITY_ROW,
  ActivityAction,
  ActivityEmpty,
  ActivityGroup,
} from "./primitives";

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
 * Everything about a port forward, in the panel that owns running things.
 *
 * Settings used to keep a second copy of this list — the same forward with
 * two homes that could disagree, one of them on a page about preferences.
 * A forward is a process, so the list lives here, and the editing that
 * only the Settings copy could do came with it.
 */
export function PortForwardsTab() {
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
          title: "Failed to start port forward",
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
          title: "Failed to stop port forward",
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
          title: "Failed to delete port forward",
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
        title: "Started port forwards",
        description: `${result.started} started, ${result.skipped} already running, ${result.failed} failed.`,
      });
    } catch (error) {
      toast({
        title: "Failed to start port forwards",
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
        title="Connect to a cluster to manage port forwards"
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
      {sessions.length > 0 && (
        <ActivityGroup title="Running" count={sessions.length}>
          {sessions.map((session) => {
            const status = statusBySession[session.id];
            const isBusy = busyIds.has(session.id);
            const isError = status?.status === "error";
            const isReconnecting =
              status?.status === "reconnecting" ||
              status?.status === "reconnected";

            return (
              <div key={session.id} className={ACTIVITY_ROW}>
                <span
                  aria-hidden="true"
                  className={cn(
                    "h-1.5 w-1.5 flex-none rounded-full",
                    isError ? "bg-err" : isReconnecting ? "bg-warn" : "bg-ok"
                  )}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">
                    {/* The panel's whole job is telling you what is running
                        and against what; the target was the one thing in it
                        you could not get to. */}
                    <ResourceRef
                      kind={ResourceType.Pod}
                      name={session.pod}
                      namespace={session.namespace}
                      showKind={false}
                    />
                  </span>
                  <span className="block truncate font-mono text-[11px] text-fg-fnt">
                    {session.namespace} · :{session.localPort} → :
                    {session.remotePort}
                    {isError && " · failed"}
                    {isReconnecting && " · reconnecting"}
                  </span>
                </span>
                <ActivityAction
                  aria-label={`Stop forwarding ${session.pod}`}
                  onClick={() => handleStop(session.id)}
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
          })}
        </ActivityGroup>
      )}

      <ActivityGroup
        title="Saved"
        count={contextConfigs.length}
        action={
          <span className="flex items-center gap-0.5">
            {idleCount > 1 && (
              <ActivityAction onClick={handleStartAll} disabled={startingAll}>
                <Play className="h-3 w-3" />
                {startingAll ? "Starting…" : "Start all"}
              </ActivityAction>
            )}
            <ActivityAction onClick={() => setEditing(null)}>
              <Plus className="h-3 w-3" />
              New
            </ActivityAction>
          </span>
        }
      >
        {contextConfigs.length === 0 ? (
          <ActivityEmpty
            icon={Network}
            title="No port forwards saved"
            hint="Save one here, or from a pod's ports"
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
                        auto
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
                  aria-label={`${activeSession ? "Stop" : "Start"} ${config.name}`}
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
                      aria-label={`More actions for ${config.name}`}
                    >
                      <MoreHorizontal className="h-3.5 w-3.5" />
                    </ActivityAction>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => setEditing(config)}>
                      <Pencil className="mr-2 h-3.5 w-3.5" />
                      Edit
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      className="text-err"
                      onSelect={() => handleDelete(config)}
                    >
                      <Trash2 className="mr-2 h-3.5 w-3.5" />
                      Delete
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
