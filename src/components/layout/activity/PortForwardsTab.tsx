import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Play,
  Square,
  Plus,
  Settings,
  AlertCircle,
  Loader2,
  Network,
} from "lucide-react";
import { usePortForwardStore } from "@/stores/portForwardStore";
import { useClusterStore } from "@/stores/clusterStore";
import { cn } from "@/lib/utils";
import {
  ACTIVITY_ROW,
  ActivityAction,
  ActivityEmpty,
  ActivityGroup,
} from "./primitives";

interface PortForwardsTabProps {
  onClose?: () => void;
}

export function PortForwardsTab({ onClose }: PortForwardsTabProps) {
  const navigate = useNavigate();
  const currentContext = useClusterStore((state) => state.currentContext);
  const {
    configs,
    sessions,
    statusBySession,
    startConfig,
    stopSession,
    configsLoaded,
    refreshConfigs,
  } = usePortForwardStore();

  const [loadingIds, setLoadingIds] = useState<Set<string>>(new Set());

  const contextConfigs = configs.filter(
    (config) => config.context === currentContext
  );

  const sessionByKey = new Map(
    sessions.map((session) => [
      `${session.context}:${session.pod}:${session.namespace}:${session.localPort}:${session.remotePort}`,
      session,
    ])
  );

  const getConfigKey = (config: (typeof configs)[0]) =>
    `${config.context}:${config.pod}:${config.namespace}:${config.localPort}:${config.remotePort}`;

  const handleStart = async (configId: string) => {
    setLoadingIds((prev) => new Set(prev).add(configId));
    try {
      await startConfig(configId);
    } catch (error) {
      console.error("Failed to start port forward:", error);
    } finally {
      setLoadingIds((prev) => {
        const next = new Set(prev);
        next.delete(configId);
        return next;
      });
    }
  };

  const handleStop = async (sessionId: string) => {
    setLoadingIds((prev) => new Set(prev).add(sessionId));
    try {
      await stopSession(sessionId);
    } catch (error) {
      console.error("Failed to stop port forward:", error);
    } finally {
      setLoadingIds((prev) => {
        const next = new Set(prev);
        next.delete(sessionId);
        return next;
      });
    }
  };

  const goToSettings = () => {
    onClose?.();
    navigate("/settings");
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
    refreshConfigs();
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
            const isLoading = loadingIds.has(session.id);
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
                  <span className="block truncate text-fg-mid">
                    {session.pod}
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
                  disabled={isLoading}
                >
                  {isLoading ? (
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
            <ActivityAction onClick={goToSettings}>
              <Plus className="h-3 w-3" />
              New
            </ActivityAction>
            <ActivityAction
              aria-label="Port forward settings"
              onClick={goToSettings}
            >
              <Settings className="h-3 w-3" />
            </ActivityAction>
          </span>
        }
      >
        {contextConfigs.length === 0 ? (
          <ActivityEmpty
            icon={Network}
            title="No port forwards configured"
            hint="Create one in Settings or from a pod"
          />
        ) : (
          contextConfigs.map((config) => {
            const activeSession = sessionByKey.get(getConfigKey(config));
            const isActive = !!activeSession;
            const isLoading = loadingIds.has(config.id);

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
                    {config.pod} · :{config.localPort} → :{config.remotePort}
                  </span>
                </span>
                <ActivityAction
                  aria-label={`${isActive ? "Stop" : "Start"} ${config.name}`}
                  onClick={() =>
                    isActive
                      ? handleStop(activeSession.id)
                      : handleStart(config.id)
                  }
                  disabled={isLoading}
                >
                  {isLoading ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : isActive ? (
                    <Square className="h-3.5 w-3.5" />
                  ) : (
                    <Play className="h-3.5 w-3.5" />
                  )}
                </ActivityAction>
              </div>
            );
          })
        )}
      </ActivityGroup>
    </div>
  );
}
