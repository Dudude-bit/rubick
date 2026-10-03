import { useNavigate } from "react-router-dom";
import { Terminal, AlertCircle } from "lucide-react";
import { useTerminalSessionStore } from "@/stores/terminalSessionStore";
import { useClusterStore } from "@/stores/clusterStore";
import { cn } from "@/lib/utils";
import { RealtimeAge } from "@/components/ui/realtime";
import { getResourceDetailUrl } from "@/lib/navigation-utils";
import { ResourceType } from "@/lib/resource-registry";
import { ResourceRef } from "@/components/resources/ResourceRef";
import { ACTIVITY_ROW, ActivityEmpty, ActivityGroup } from "./primitives";
import { useT } from "@/i18n/useT";

interface TerminalsTabProps {
  onClose?: () => void;
}

export function TerminalsTab({ onClose }: TerminalsTabProps) {
  const t = useT();
  const navigate = useNavigate();
  const currentContext = useClusterStore((state) => state.currentContext);
  const sessions = useTerminalSessionStore((state) => state.sessions);

  const contextSessions = sessions.filter(
    (session) => session.context === currentContext
  );

  const handleNavigateToPod = (namespace: string, podName: string) => {
    onClose?.();
    // `ResourceType.Pod` is the kind, "Pod"; the route is the plural. Building
    // the path by hand produced `/Pod/ns/name`, which matches nothing.
    navigate(getResourceDetailUrl(ResourceType.Pod, podName, namespace));
  };

  if (!currentContext) {
    return (
      <ActivityEmpty
        icon={AlertCircle}
        title={t("empty", "connectToViewTerminals")}
      />
    );
  }

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
                if ((event.target as HTMLElement).closest("a")) return;
                handleNavigateToPod(session.namespace, session.podName);
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                handleNavigateToPod(session.namespace, session.podName);
              }}
            >
              {/* The status word rides in the secondary line so the dot is
                  never the only thing carrying it. */}
              <span
                aria-hidden="true"
                className={cn("h-1.5 w-1.5 flex-none rounded-full", state.tone)}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate">
                  <ResourceRef
                    kind={ResourceType.Pod}
                    name={session.podName}
                    namespace={session.namespace}
                    showKind={false}
                  />
                </span>
                <span className="block truncate font-mono text-[11px] text-fg-fnt">
                  {session.namespace} · {session.containerName} · {state.label}
                </span>
              </span>
              <RealtimeAge
                timestamp={session.createdAt}
                className="flex-none text-[11px] text-fg-fnt"
              />
            </div>
          );
        })}
      </ActivityGroup>

      {contextSessions.some((s) => s.status === "error") && (
        <p className="px-3 pt-2 text-[11px] text-err">
          {t("empty", "sessionsHaveErrors")}
        </p>
      )}
    </div>
  );
}
