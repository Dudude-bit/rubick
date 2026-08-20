import { useState, useRef, useCallback, useEffect } from "react";
import { commands } from "@/lib/commands";
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
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const elapsedIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const isCancelledRef = useRef(false);

  const cleanup = useCallback(() => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
    if (elapsedIntervalRef.current) {
      clearInterval(elapsedIntervalRef.current);
      elapsedIntervalRef.current = null;
    }
  }, []);

  const startPolling = useCallback(
    (op: DebugOperation) => {
      cleanup();
      isCancelledRef.current = false;
      setElapsedSeconds(0);

      elapsedIntervalRef.current = setInterval(() => {
        setElapsedSeconds((prev) => prev + 1);
      }, 1000);

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
        onError(String(err));
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
        onError(String(err));
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
        onError(String(err));
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
    setElapsedSeconds(0);
  }, [operation, cleanup]);

  const continueWaiting = useCallback(async () => {
    if (operation) {
      try {
        // Extend timeout on backend before resuming polling
        await commands.extendDebugTimeout(operation.id, null);
        setElapsedSeconds(0);
        setState("polling");
        startPolling(operation);
      } catch (error) {
        console.error("Failed to extend timeout:", error);
        onError(String(error));
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
