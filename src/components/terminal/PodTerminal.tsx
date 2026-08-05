import { useState, useEffect, useCallback, useRef } from "react";
import { Terminal, TerminalMetadata } from "./Terminal";
import { Button } from "@/components/ui/button";
import { RefreshCw } from "lucide-react";
import { commands } from "@/lib/commands";
import { normalizeTauriError } from "@/lib/error-utils";
import { useTerminalSessionStore } from "@/stores/terminalSessionStore";
import { useClusterStore } from "@/stores/clusterStore";

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

        // Check regular containers
        const container = pod.containers?.find(
          (item) => item.name === containerName
        );

        if (container) {
          if (container.state.type === "terminated") {
            const reason = container.state.reason
              ? `: ${container.state.reason}`
              : "";
            setUnavailableReason(`Container terminated${reason}`);
            disconnect();
            return;
          }
        }

        const phase = pod.status.phase.toLowerCase();
        if (phase === "failed" || phase === "succeeded") {
          setUnavailableReason(`Pod ${pod.status.phase}`);
          disconnect();
        }
      } catch (err) {
        const errorText = normalizeTauriError(err);
        if (errorText.includes("not found") || errorText.includes("NotFound")) {
          setUnavailableReason("Pod not found");
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
  }, [sessionId, podName, namespace, containerName, disconnect]);

  const handleClose = useCallback(() => {
    disconnect();
    onClose?.();
  }, [disconnect, onClose]);

  // Show reconnect button if not connected and not connecting
  const showReconnect =
    !sessionId && !isConnecting && (error || unavailableReason);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-canvas">
      {showReconnect && (
        <div className="flex items-center justify-between gap-3 border-b border-hair px-4 py-2">
          <div className="flex min-w-0 items-center gap-2 text-sm">
            <span className="text-xs text-fg-mut">
              {error || unavailableReason}
            </span>
          </div>
          <Button variant="outline" size="sm" onClick={connect}>
            <RefreshCw className="mr-2 h-3.5 w-3.5" />
            Reconnect
          </Button>
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
