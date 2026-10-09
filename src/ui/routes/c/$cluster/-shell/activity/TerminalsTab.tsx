import { useNavigate } from "@tanstack/react-router";
import { Terminal, AlertCircle, X } from "lucide-react";
import { useTerminalSessionStore } from "@/stores/terminalSessionStore";
import { useClusterStore } from "@/stores/clusterStore";
import { commands } from "@/lib/commands";
import { cn } from "@/lib/utils";
import { RealtimeAge } from "@/components/ui/realtime";
import { objectLink } from "@/lib/links";
import { ResourceType } from "@/lib/resource-registry";
import { ResourceRef } from "@/components/object/ResourceRef";
import type { TerminalState } from "@/generated/types";
import {
  ACTIVITY_ROW,
  ActivityAction,
  ActivityEmpty,
  ActivityGroup,
} from "./primitives";
import { useT } from "@/i18n/useT";

const TONE: Record<TerminalState, string> = {
  idle: "bg-fg-fnt",
  connecting: "bg-warn",
  connected: "bg-ok",
  closing: "bg-fg-fnt",
  disconnected: "bg-fg-fnt",
  error: "bg-err",
};

interface TerminalsTabProps {
  onClose?: () => void;
}

export function TerminalsTab({ onClose }: TerminalsTabProps) {
  const t = useT();
  const navigate = useNavigate();
  const currentContext = useClusterStore((state) => state.currentContext);
  const sessions = useTerminalSessionStore((state) => state.sessions);
  const failed = useTerminalSessionStore((state) => state.failed);

  const handleNavigateToPod = (namespace: string, podName: string) => {
    onClose?.();
    const link = objectLink({
      kind: ResourceType.Pod,
      name: podName,
      namespace,
    });
    if (link) void navigate(link);
  };

  if (!currentContext) {
    return (
      <ActivityEmpty
        icon={AlertCircle}
        title={t("empty", "connectToViewTerminals")}
      />
    );
  }

  if (sessions === null) {
    return failed ? (
      <ActivityEmpty
        icon={AlertCircle}
        title={t("activity", "terminalsUnread")}
        hint={failed}
      />
    ) : (
      <ActivityEmpty
        icon={Terminal}
        title={t("activity", "readingTerminals")}
      />
    );
  }

  const contextSessions = sessions.filter(
    (session) => session.context === currentContext
  );

  if (contextSessions.length === 0) {
    // The scope belongs in the copy: this list is filtered to the current
    // context, so a shell left open on another cluster is not gone — it is
    // just not here, and "no terminal sessions" said otherwise.
    return (
      <ActivityEmpty
        icon={Terminal}
        title={t("empty", "noTerminalsOnContext", { context: currentContext })}
        hint={
          sessions.length > 0
            ? t("count", "openOnOtherClusters", { n: sessions.length })
            : t("empty", "openFromPodPage")
        }
      />
    );
  }

  return (
    <div className="pb-3">
      <ActivityGroup
        title={t("activity", "sessions")}
        count={contextSessions.length}
      >
        {contextSessions.map((session) => (
          // A `role="link"` div rather than a button, because the pod name
          // inside it is a real anchor now and an anchor cannot live in a
          // button. Same split the resource tables use: the row opens the
          // page, the name opens the peek.
          <div
            key={session.id}
            role="link"
            tabIndex={0}
            className={cn(
              ACTIVITY_ROW,
              "w-full cursor-pointer text-left hover:bg-hover"
            )}
            onClick={(event) => {
              if ((event.target as HTMLElement).closest("a, button")) return;
              handleNavigateToPod(session.namespace, session.pod);
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.target !== event.currentTarget)
                return;
              handleNavigateToPod(session.namespace, session.pod);
            }}
          >
            {/* The status word rides in the secondary line so the dot is
                never the only thing carrying it. */}
            <span
              aria-hidden="true"
              className={cn(
                "h-1.5 w-1.5 flex-none rounded-full",
                TONE[session.state]
              )}
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate">
                <ResourceRef
                  kind={ResourceType.Pod}
                  name={session.pod}
                  namespace={session.namespace}
                  showKind={false}
                />
              </span>
              <span className="block truncate font-mono text-[11px] text-fg-fnt">
                {session.namespace} · {session.container} · {session.state}
              </span>
            </span>
            <RealtimeAge
              timestamp={session.openedAt}
              className="flex-none text-[11px] text-fg-fnt"
            />
            <ActivityAction
              aria-label={t("activity", "endShell", { pod: session.pod })}
              disabled={session.state === "closing"}
              onClick={() => void commands.closeTerminal(session.id)}
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </ActivityAction>
          </div>
        ))}
      </ActivityGroup>
    </div>
  );
}
