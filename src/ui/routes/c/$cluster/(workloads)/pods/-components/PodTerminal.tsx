import { useState, useEffect, useCallback, useRef } from "react";
import { Terminal, TerminalMetadata } from "@/components/terminal/Terminal";
import { Button } from "@/components/ui/button";
import { RefreshCw } from "lucide-react";
import { commands } from "@/lib/commands";
import { podContainers } from "@/lib/container-sequence";
import { normalizeTauriError, ERROR_CODES, errorCode } from "@/lib/error-utils";
import { describeTermination } from "@/lib/pod-status";
import { listenForStreamFailure } from "@/lib/stream-failure";
import { listenEvent } from "@/lib/events";
import { useT } from "@/i18n/useT";
import { useClusterStore } from "@/stores/clusterStore";
import { useScopeTabStore } from "@/stores/scopeTabStore";
import {
  endShell,
  keptOn,
  scrollbackOf,
  useKeptShellStore,
} from "@/stores/keptShellStore";

export interface PodTerminalProps {
  podName: string;
  namespace: string;
  containerName: string;
  onClose?: () => void;
}

/**
 * Pod-specific terminal wrapper: opens the shell, or attaches to the one this
 * tab already keeps here, and ends it when the reader or the pod does. Going
 * away does not end it; its tab does (`useKeptShells`).
 */
export function PodTerminal({
  podName,
  namespace,
  containerName,
  onClose,
}: PodTerminalProps) {
  const t = useT();
  const [kept] = useState(() => {
    const shell = keptOn(useKeptShellStore.getState().shells, {
      tab: useScopeTabStore.getState().activeId,
      context: useClusterStore.getState().currentContext,
      namespace,
      pod: podName,
    });
    return shell?.container === containerName ? shell.id : null;
  });
  const [sessionId, setSessionId] = useState<string | null>(kept);
  const [error, setError] = useState<string | null>(null);
  const [unavailableReason, setUnavailableReason] = useState<string | null>(
    null
  );
  const [isConnecting, setIsConnecting] = useState(false);
  const [ended, setEnded] = useState(false);
  const connectAttemptRef = useRef(0);
  const sessionIdRef = useRef<string | null>(kept);
  // The shell opens at the pane's size, so it never has to be told one later.
  const sizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const [measured, setMeasured] = useState(false);
  const onSize = useCallback((cols: number, rows: number) => {
    sizeRef.current = { cols, rows };
    setMeasured(true);
  }, []);

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
        null,
        sizeRef.current?.cols ?? null,
        sizeRef.current?.rows ?? null
      );

      if (connectAttemptRef.current !== attemptId) {
        // Cleanup happened while connecting
        await commands.closeTerminal(sid);
        return;
      }

      useKeptShellStore.getState().keep({
        id: sid,
        tab: useScopeTabStore.getState().activeId,
        context: useClusterStore.getState().currentContext ?? "",
        namespace,
        pod: podName,
        container: containerName,
      });
      sessionIdRef.current = sid;
      setSessionId(sid);
      setEnded(false);
      setIsConnecting(false);
    } catch (err) {
      console.error("Failed to open shell:", err);
      if (connectAttemptRef.current === attemptId) {
        setError(normalizeTauriError(err));
        setIsConnecting(false);
      }
    }
  }, [namespace, podName, containerName]);

  const disconnect = useCallback(() => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    void endShell(sid);
    setSessionId(null);
  }, []);

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
    const unlistens: Array<() => void> = [];
    const keep = (fn: () => void) => {
      if (disposed) fn();
      else unlistens.push(fn);
    };

    // The pane keeps its scrollback under "Ended".
    void listenEvent("terminal-closed", (event) => {
      const sid = sessionIdRef.current;
      if (!sid || event.payload.session_id !== sid) return;
      setEnded(true);
    }).then(keep);

    listenForStreamFailure(
      () => sessionIdRef.current,
      (failure) => {
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
    ).then(keep);

    return () => {
      disposed = true;
      unlistens.forEach((fn) => fn());
    };
  }, []);

  // Opens once the pane has its size, unless there is a kept one to attach
  // to. A shell still being opened when the pane goes is closed by `connect`
  // when its id arrives; an open one stays with its tab.
  useEffect(() => {
    if (measured && !kept) connect();
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [measured]);
  useEffect(
    () => () => {
      connectAttemptRef.current += 1;
    },
    []
  );
  const replay = useCallback(() => scrollbackOf(sessionIdRef.current), []);

  // Poll for pod status while connected
  useEffect(() => {
    if (!sessionId || ended) return;

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
        if (errorCode(err) === ERROR_CODES.NOT_FOUND) {
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
  }, [sessionId, ended, podName, namespace, containerName, disconnect, t]);

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
        onSize={onSize}
        replay={replay}
        ownsSession={false}
      />
    </div>
  );
}
