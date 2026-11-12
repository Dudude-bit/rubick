import { useState, useRef, useCallback, useEffect } from "react";
import { useNowSeconds } from "@/hooks/useNow";
import { commands } from "@/lib/commands";
import { errorToShow } from "@/lib/error-utils";
import type { T } from "@/i18n/useT";
import type {
  DebugConfig,
  DebugOperation,
  DebugResult,
  MadePod,
} from "@/generated/types";

/**
 * Why a debug session failed, and what became of the pod it made: a copy
 * left running is the workload a second time, so it is never left unsaid.
 */
export function debugFailureWords(
  error: string,
  pod: MadePod | null | undefined,
  t: T
): string {
  if (!pod) return error;
  const fate = t("action", pod.deleted ? "debugPodRemoved" : "debugPodLeft", {
    pod: pod.name,
  });
  return `${error}. ${fate}`;
}

export type DebugOperationState =
  | "idle"
  | "creating"
  | "polling"
  | "ready"
  | "failed"
  | "timeout";

interface UseDebugOperationOptions {
  onReady: (result: DebugResult) => void;
  /** `pod` is what the operation made in the cluster, removed or still there. */
  onError: (error: string, pod?: MadePod | null) => void;
  onTimeout: (operation: DebugOperation) => void;
  pollInterval?: number;
}

export function useDebugOperation({
  onReady,
  onError,
  onTimeout,
  pollInterval = 2000,
}: UseDebugOperationOptions) {
  const [state, setState] = useState<DebugOperationState>("idle");
  const [operation, setOperation] = useState<DebugOperation | null>(null);
  const [statusReason, setStatusReason] = useState<string | null>(null);
  // When polling began, not a count of ticks: a hidden window throttles
  // timers, and a counter that missed them would say less time had passed.
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const now = useNowSeconds(state === "polling");
  // Both ends in whole seconds: the clock is, and a start kept to the
  // millisecond left the count one behind for the whole wait.
  const elapsedSeconds =
    startedAt === null
      ? 0
      : Math.max(0, Math.floor(now / 1000) - Math.floor(startedAt / 1000));

  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const isCancelledRef = useRef(false);
  // The operation still waited on. Unmounting then is no choice to keep its
  // pod: nobody is left to enter it, or to be told its name.
  const waitingRef = useRef<string | null>(null);

  const cleanup = useCallback(() => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
  }, []);

  const startPolling = useCallback(
    (op: DebugOperation) => {
      cleanup();
      isCancelledRef.current = false;
      waitingRef.current = op.id;
      setStartedAt(Date.now());

      const poll = async () => {
        if (isCancelledRef.current) return;

        try {
          const status = await commands.getDebugStatus(op.id);

          if (isCancelledRef.current) return;

          if (status.type !== "pending") {
            cleanup();
            waitingRef.current = null;
          }
          if (status.type === "ready") {
            setState("ready");
            onReady(status.result);
          } else if (status.type === "failed") {
            setState("failed");
            onError(status.error, status.pod);
          } else if (status.type === "timeout") {
            setState("timeout");
            onTimeout(op);
          } else if (status.type === "pending") {
            setStatusReason(status.reason);
          }
        } catch (err) {
          console.error("Failed to get debug status:", err);
        }
      };

      poll();
      pollIntervalRef.current = setInterval(poll, pollInterval);
    },
    [cleanup, pollInterval, onReady, onError, onTimeout]
  );

  const start = useCallback(
    async (create: () => Promise<DebugOperation>) => {
      setState("creating");
      setStatusReason(null);
      isCancelledRef.current = false;

      try {
        const op = await create();
        // Cancelled or unmounted while the create was in flight: nobody
        // waits for this operation, so what it made goes with it.
        if (isCancelledRef.current) {
          void commands.cancelDebugOperation(op.id).catch(() => {});
          return;
        }
        setOperation(op);
        setState("polling");
        startPolling(op);
      } catch (err) {
        setState("failed");
        onError(errorToShow(err));
      }
    },
    [startPolling, onError]
  );

  const startEphemeral = useCallback(
    (podName: string, namespace: string, config: DebugConfig) =>
      start(() => commands.debugPodEphemeral(podName, namespace, config)),
    [start]
  );

  const startCopyPod = useCallback(
    (podName: string, namespace: string, config: DebugConfig) =>
      start(() => commands.debugPodCopy(podName, namespace, config)),
    [start]
  );

  const startNodeDebug = useCallback(
    (nodeName: string, namespace: string, config: DebugConfig) =>
      start(() => commands.debugNode(nodeName, namespace, config)),
    [start]
  );

  const cancel = useCallback(async () => {
    isCancelledRef.current = true;
    waitingRef.current = null;
    cleanup();

    if (operation) {
      try {
        await commands.cancelDebugOperation(operation.id);
      } catch (err) {
        console.error("Failed to cancel debug operation:", err);
      }
    }

    setOperation(null);
    setState("idle");
    setStatusReason(null);
    setStartedAt(null);
  }, [operation, cleanup]);

  const continueWaiting = useCallback(async () => {
    if (operation) {
      try {
        // Extend timeout on backend before resuming polling
        await commands.extendDebugTimeout(operation.id, null);
        setStartedAt(null);
        setState("polling");
        startPolling(operation);
      } catch (error) {
        console.error("Failed to extend timeout:", error);
        onError(errorToShow(error));
      }
    }
  }, [operation, startPolling, onError]);

  useEffect(() => {
    return () => {
      isCancelledRef.current = true;
      cleanup();
      const waited = waitingRef.current;
      waitingRef.current = null;
      if (waited) void commands.cancelDebugOperation(waited).catch(() => {});
    };
  }, [cleanup]);

  return {
    state,
    operation,
    statusReason,
    elapsedSeconds,
    startEphemeral,
    startCopyPod,
    startNodeDebug,
    cancel,
    continueWaiting,
  };
}
