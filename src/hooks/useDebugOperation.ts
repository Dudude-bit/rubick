import { useState, useRef, useCallback, useEffect } from "react";
import { useNowSeconds } from "@/hooks/useNow";
import { commands } from "@/lib/commands";
import { errorToShow } from "@/lib/error-utils";
import type {
  DebugConfig,
  DebugOperation,
  DebugResult,
} from "@/generated/types";

export type DebugOperationState =
  "idle" | "creating" | "polling" | "ready" | "failed" | "timeout";

interface UseDebugOperationOptions {
  onReady: (result: DebugResult) => void;
  onError: (error: string) => void;
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
  const elapsedSeconds =
    startedAt === null ? 0 : Math.max(0, Math.floor((now - startedAt) / 1000));

  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const isCancelledRef = useRef(false);

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
      setStartedAt(Date.now());

      const poll = async () => {
        if (isCancelledRef.current) return;

        try {
          const status = await commands.getDebugStatus(op.id);

          if (isCancelledRef.current) return;

          if (status.type === "ready") {
            cleanup();
            setState("ready");
            onReady(status.result);
          } else if (status.type === "failed") {
            cleanup();
            setState("failed");
            onError(status.error);
          } else if (status.type === "timeout") {
            cleanup();
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

  const startEphemeral = useCallback(
    async (podName: string, namespace: string, config: DebugConfig) => {
      setState("creating");
      setStatusReason(null);
      isCancelledRef.current = false;

      try {
        const op = await commands.debugPodEphemeral(podName, namespace, config);
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

  const startCopyPod = useCallback(
    async (podName: string, namespace: string, config: DebugConfig) => {
      setState("creating");
      setStatusReason(null);
      isCancelledRef.current = false;

      try {
        const op = await commands.debugPodCopy(podName, namespace, config);
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

  const startNodeDebug = useCallback(
    async (nodeName: string, namespace: string, config: DebugConfig) => {
      setState("creating");
      setStatusReason(null);
      isCancelledRef.current = false;

      try {
        const op = await commands.debugNode(nodeName, namespace, config);
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

  const cancel = useCallback(async () => {
    isCancelledRef.current = true;
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
