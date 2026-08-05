import { useNavigate } from "react-router-dom";
import { Terminal, AlertCircle } from "lucide-react";
import { useTerminalSessionStore } from "@/stores/terminalSessionStore";
import { useClusterStore } from "@/stores/clusterStore";
import { cn } from "@/lib/utils";
import { RealtimeAge } from "@/components/ui/realtime";
import { ResourceType } from "@/lib/resource-registry";
import { ACTIVITY_ROW, ActivityEmpty, ActivityGroup } from "./primitives";

interface TerminalsTabProps {
  onClose?: () => void;
}

export function TerminalsTab({ onClose }: TerminalsTabProps) {
  const navigate = useNavigate();
  const currentContext = useClusterStore((state) => state.currentContext);
  const sessions = useTerminalSessionStore((state) => state.sessions);

  const contextSessions = sessions.filter(
    (session) => session.context === currentContext
  );

  const handleNavigateToPod = (namespace: string, podName: string) => {
    onClose?.();
    navigate(`/${ResourceType.Pod}/${namespace}/${podName}`);
  };

  if (!currentContext) {
    return (
      <ActivityEmpty
        icon={AlertCircle}
        title="Connect to a cluster to view terminals"
      />
    );
  }

  if (contextSessions.length === 0) {
    return (
      <ActivityEmpty
        icon={Terminal}
        title="No terminal sessions"
        hint="Open a terminal from any pod's detail page"
      />
    );
  }

  return (
    <div className="pb-3">
      <ActivityGroup title="Sessions" count={contextSessions.length}>
        {contextSessions.map((session) => {
          const state =
            session.status === "connected"
              ? { tone: "bg-ok", label: "connected" }
              : session.status === "error"
                ? { tone: "bg-err", label: "error" }
                : session.status === "connecting"
                  ? { tone: "bg-warn", label: "connecting" }
                  : { tone: "bg-fg-fnt", label: session.status };

          return (
            <button
              key={session.id}
              type="button"
              className={cn(ACTIVITY_ROW, "w-full text-left hover:bg-hover")}
              onClick={() =>
                handleNavigateToPod(session.namespace, session.podName)
              }
            >
              {/* The status word rides in the secondary line so the dot is
                  never the only thing carrying it. */}
              <span
                aria-hidden="true"
                className={cn("h-1.5 w-1.5 flex-none rounded-full", state.tone)}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-fg-mid">
                  {session.podName}
                </span>
                <span className="block truncate font-mono text-[11px] text-fg-fnt">
                  {session.namespace} · {session.containerName} · {state.label}
                </span>
              </span>
              <RealtimeAge
                timestamp={session.createdAt}
                className="flex-none text-[11px] text-fg-fnt"
              />
            </button>
          );
        })}
      </ActivityGroup>

      {contextSessions.some((s) => s.status === "error") && (
        <p className="px-3 pt-2 text-[11px] text-err">
          Some sessions have errors. Open one to reconnect.
        </p>
      )}
    </div>
  );
}
