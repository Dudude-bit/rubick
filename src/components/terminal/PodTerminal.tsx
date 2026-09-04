import { useState, useEffect, useCallback, useRef } from "react";
import { Terminal, TerminalMetadata } from "./Terminal";
import { Button } from "@/components/ui/button";
import { RefreshCw } from "lucide-react";
import { commands } from "@/lib/commands";
import { podContainers } from "@/lib/container-sequence";
import { normalizeTauriError } from "@/lib/error-utils";
import { describeTermination } from "@/lib/pod-status";
import { listenForStreamFailure } from "@/lib/stream-failure";
import { useTerminalSessionStore } from "@/stores/terminalSessionStore";
import { useClusterStore } from "@/stores/clusterStore";
import { useT } from "@/i18n/useT";

export interface PodTerminalProps {
  podName: string;
  namespace: string;
  containerName: string;
  onClose?: () => void;
}

/**
 * Pod-specific terminal wrapper.
 * Handles pod session creation, polling, and lifecycle management.
 * Uses the generic Terminal component for rendering.
 */
export function PodTerminal({
  podName,
  namespace,
  containerName,
  onClose,
}: PodTerminalProps) {
  const t = useT();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unavailableReason, setUnavailableReason] = useState<string | null>(
    null
  );
  const [isConnecting, setIsConnecting] = useState(false);
  const connectAttemptRef = useRef(0);
  const sessionIdRef = useRef<string | null>(null);

  const currentContext = useClusterStore((state) => state.currentContext);
  const { addSession, removeSession } = useTerminalSessionStore();

  // Keep sessionIdRef in sync
  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  const metadata: TerminalMetadata = {
    title: podName,
    subtitle: containerName,
  };

  // Connect to pod
  const connect = useCallback(async () => {
    const attemptId = connectAttemptRef.current + 1;
    connectAttemptRef.current = attemptId;

    setIsConnecting(true);
    setError(null);
    setUnavailableReason(null);

    try {
      const sid = await commands.openPodShell(
        namespace,
        podName,
        containerName,
        null
      );

      if (connectAttemptRef.current !== attemptId) {
        // Cleanup happened while connecting
        await commands.closeTerminal(sid);
        return;
      }

      sessionIdRef.current = sid;
      setSessionId(sid);
      setIsConnecting(false);

      // Add to activity tracking
      addSession({
        id: sid,
        context: currentContext ?? "unknown",
        podName,
        namespace,
        containerName,
        status: "connected",
      });
    } catch (err) {
      console.error("Failed to open shell:", err);
      if (connectAttemptRef.current === attemptId) {
        setError(normalizeTauriError(err));
        setIsConnecting(false);
      }
    }
  }, [namespace, podName, containerName, currentContext, addSession]);

  // Disconnect from pod
  const disconnect = useCallback(async () => {
    if (sessionId) {
      removeSession(sessionId);
      await commands.closeTerminal(sessionId);
      setSessionId(null);
    }
  }, [sessionId, removeSession]);

  // A session that dies on its own. `openPodShell` hands back an id
  // before the exec upgrade has been answered, so a rejected handshake
  // — a 500 on this cluster — used to leave `sessionId` set, `error`
  // null and the pane blank forever.
  //
  // Registered once on mount, matching against a ref, so it exists
  // before any id does. The backend holds the failure until
  // `terminalSubscribed` releases its gate, which the inner Terminal
  // only calls after this component has already stored the id.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;

    listenForStreamFailure(
      () => sessionIdRef.current,
      (failure) => {
        const sid = sessionIdRef.current;
        if (sid) removeSession(sid);
        sessionIdRef.current = null;
        setSessionId(null);
        setIsConnecting(false);
        // Two banners, one component: `unavailableReason` is the
        // no-way-back copy the pod-status poll already writes, `error`
        // is the retryable one.
        if (failure.kind === "gone") {
          setUnavailableReason(failure.message);
        } else {
          setError(failure.message);
        }
      }
    ).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [removeSession]);

  // Initial connection: fire-and-forget async session startup, which
  // ends up calling setSessionId inside. Genuine side-effect (talks
  // to the backend); not derivable.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    connect();

    // Cleanup on unmount - use ref to get current sessionId
    return () => {
      const sid = sessionIdRef.current;
      if (sid) {
        removeSession(sid);
        commands.closeTerminal(sid).catch(() => {});
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Poll for pod status while connected
  useEffect(() => {
    if (!sessionId) return;

    let cancelled = false;

    const checkPodState = async () => {
      if (cancelled) return;

      try {
        const pod = await commands.getPod(podName, namespace);

        // Both lists: a shell attached to a sidecar is attached to an
        // entry of `.initContainers`, and looking for it in `.containers`
        // found nothing and left the pane open over a dead process.
        const container = podContainers(pod).find(
          (item) => item.name === containerName
        );

        if (container?.state.type === "terminated") {
          setUnavailableReason(
            t("empty", "containerTerminated", {
              detail: describeTermination(container.state.termination),
            })
          );
          disconnect();
          return;
        }

        // The word kubectl prints, not the raw phase, and through the
        // catalogue rather than a template literal. This panel and the peek
        // action beside it describe the same pod one click apart, and they
        // said different words about it — «Pod Failed» here against the
        // peek's «Error» — with this one staying English in every language.
        // `PodShell` next door already reads `status.display`.
        const phase = pod.status.phase.toLowerCase();
        if (phase === "failed" || phase === "succeeded") {
          // The sentence `PodShell` next door already uses for the same
          // situation. Reading the same status word and then saying it in a
          // second sentence would leave this pair — the peek, the shell and
          // the terminal, all one click apart — describing one pod three
          // ways, which is what this change was meant to stop.
          setUnavailableReason(
            t("empty", "podIsStatusNoneRunning", {
              status: pod.status.display || pod.status.phase,
            })
          );
          disconnect();
        }
      } catch (err) {
        const errorText = normalizeTauriError(err);
        if (errorText.includes("not found") || errorText.includes("NotFound")) {
          setUnavailableReason(t("empty", "podNotFound"));
          disconnect();
        }
      }
    };

    const intervalId = window.setInterval(checkPodState, 8000);
    checkPodState();

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [sessionId, podName, namespace, containerName, disconnect, t]);

  const handleClose = useCallback(() => {
    disconnect();
    onClose?.();
  }, [disconnect, onClose]);

  // The session is down and something knows why.
  const failureReason =
    !isConnecting && !sessionId && (error || unavailableReason);
  // Only `error` is worth a button. `unavailableReason` means the
  // container itself is gone — reconnecting attaches to nothing, and
  // offering it reads as "we do not know what happened".
  const canReconnect = !!error;

  return (
    <div className="flex h-full flex-col overflow-hidden bg-canvas">
      {failureReason && (
        <div
          role="alert"
          className="flex items-start justify-between gap-3 border-b border-hair px-4 py-2"
        >
          <div className="min-w-0">
            <p className={`text-xs ${canReconnect ? "text-err" : "text-warn"}`}>
              {canReconnect
                ? t("empty", "noShellOn", {
                    target: `${podName}/${containerName}`,
                  })
                : t("empty", "noLongerAvailable", {
                    target: `${podName}/${containerName}`,
                  })}
            </p>
            <p className="mt-0.5 wrap-break-word text-[11px] text-fg-mut">
              {failureReason}
            </p>
          </div>
          {canReconnect ? (
            <Button
              variant="outline"
              size="sm"
              className="shrink-0"
              onClick={connect}
            >
              <RefreshCw className="mr-2 h-3.5 w-3.5" />
              {t("action", "reconnect")}
            </Button>
          ) : (
            <span className="shrink-0 whitespace-nowrap pt-0.5 text-[11px] text-fg-fnt">
              {t("empty", "nothingLeftToAttachTo")}
            </span>
          )}
        </div>
      )}
      <Terminal
        sessionId={sessionId}
        metadata={metadata}
        onClose={handleClose}
      />
    </div>
  );
}
