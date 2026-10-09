import { useNavigate } from "@tanstack/react-router";
import { SquareTerminal, AlertCircle, X } from "lucide-react";
import { useTerminalSessionStore } from "@/stores/terminalSessionStore";
import { useClusterStore } from "@/stores/clusterStore";
import { useScopeTabStore } from "@/stores/scopeTabStore";
import {
  endShell,
  tabKeepsShell,
  useKeptShellStore,
} from "@/stores/keptShellStore";
import { cn } from "@/lib/utils";
import { RealtimeAge } from "@/components/ui/realtime";
import { hrefOf, objectLink } from "@/lib/links";
import { ResourceType } from "@/lib/resource-registry";
import { ResourceRef } from "@/components/object/ResourceRef";
import type { TerminalSessionInfo, TerminalState } from "@/generated/types";
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
  const kept = useKeptShellStore((state) => state.shells);

  // Back to the page a shell is on, on its Shell tab: its own scope tab when
  // one keeps it, and never by taking a tab that keeps another shell away.
  const handleNavigateToShell = (session: TerminalSessionInfo) => {
    onClose?.();
    const owner = kept.find((shell) => shell.id === session.id);
    const link = objectLink(
      {
        kind: ResourceType.Pod,
        name: session.pod,
        namespace: session.namespace,
      },
      { cluster: session.context, tab: owner ? "shell" : undefined }
    );
    if (!link) return;
    const tabs = useScopeTabStore.getState();
    if (owner && owner.tab !== tabs.activeId)
      void tabs.activateTab(owner.tab, hrefOf(link));
    else if (!owner && tabKeepsShell(tabs.activeId))
      void tabs.openTab({ href: hrefOf(link), context: session.context });
    else void navigate(link);
  };

  if (sessions === null) {
    return failed ? (
      <ActivityEmpty
        icon={AlertCircle}
        title={t("activity", "terminalsUnread")}
        hint={failed}
      />
    ) : (
      <ActivityEmpty
        icon={SquareTerminal}
        title={t("activity", "readingTerminals")}
      />
    );
  }

  // Every shell, whichever tab or cluster holds it: each is a process in
  // somebody's container, and the count in the status bar is all of them.
  if (sessions.length === 0) {
    return (
      <ActivityEmpty
        icon={SquareTerminal}
        title={t("empty", "noShellsOpen")}
        hint={t("empty", "openFromPodPage")}
      />
    );
  }

  return (
    <div className="pb-3">
      <ActivityGroup title={t("activity", "sessions")} count={sessions.length}>
        {sessions.map((session) => (
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
              handleNavigateToShell(session);
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.target !== event.currentTarget)
                return;
              handleNavigateToShell(session);
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
                {/* The peek reads the cluster on screen, so a pod in another
                    one is named, not linked; the row still goes there. */}
                {session.context === currentContext ? (
                  <ResourceRef
                    kind={ResourceType.Pod}
                    name={session.pod}
                    namespace={session.namespace}
                    showKind={false}
                  />
                ) : (
                  <span className="font-mono text-fg">{session.pod}</span>
                )}
              </span>
              <span className="block truncate font-mono text-[11px] text-fg-fnt">
                {session.context !== currentContext && `${session.context} · `}
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
              onClick={() => void endShell(session.id)}
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </ActivityAction>
          </div>
        ))}
      </ActivityGroup>
    </div>
  );
}
