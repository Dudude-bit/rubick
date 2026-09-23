/**
 * Application-wide error listener.
 *
 * Mounts two subscriptions and renders its children unchanged:
 * - global errors (window.error, unhandledrejection)
 * - the cluster store's error field
 *
 * Each one is logged to the backend and surfaced as a deduplicated
 * toast. Nothing reads back from here — code that wants to report an
 * error calls `reportError` from `@/lib/error-utils` directly.
 */

import React, { useCallback, useEffect, useRef } from "react";
import { useToast } from "@/components/ui/use-toast";
import { useClusterStore } from "@/stores/clusterStore";
import {
  errorToShow,
  reportError,
  type NormalizedError,
} from "@/lib/error-utils";

const TOAST_DEDUPE_MS = 3000;

interface Props {
  children: React.ReactNode;
}

/**
 * Error Provider component - wrap your app with this
 */
export function ErrorProvider({ children }: Props) {
  const { toast } = useToast();
  const recentToasts = useRef<Map<string, number>>(new Map());

  const clusterError = useClusterStore((state) => state.error);
  const clusterErrorContext = useClusterStore((state) => state.errorContext);

  // Deduplicated toast emitter
  const emitToast = useCallback(
    (title: string, description: string) => {
      const key = `${title}:${description}`;
      const now = Date.now();
      const lastShown = recentToasts.current.get(key);

      if (lastShown && now - lastShown < TOAST_DEDUPE_MS) {
        return;
      }

      recentToasts.current.set(key, now);
      toast({
        title,
        description,
        variant: "destructive",
      });

      // Clean up old entries
      if (recentToasts.current.size > 50) {
        const cutoff = now - TOAST_DEDUPE_MS * 2;
        for (const [k, v] of recentToasts.current.entries()) {
          if (v < cutoff) {
            recentToasts.current.delete(k);
          }
        }
      }
    },
    [toast]
  );

  // Handle an error - log it and show toast
  const handleError = useCallback(
    (error: unknown, context?: string): NormalizedError => {
      const normalized = reportError(error, context);

      // Determine toast title based on error type
      let title = "Error";
      if (normalized.code !== "UNKNOWN_ERROR") {
        title = normalized.code.replace(/_/g, " ").toLowerCase();
        title = title.charAt(0).toUpperCase() + title.slice(1);
      }

      // The log keeps the command's name; the reader gets the server's words.
      emitToast(title, errorToShow(error));

      return normalized;
    },
    [emitToast]
  );

  // Handle cluster store errors
  useEffect(() => {
    if (clusterError && clusterErrorContext) {
      handleError(clusterError, clusterErrorContext);
    }
  }, [clusterError, clusterErrorContext, handleError]);

  // Listen for global window errors
  useEffect(() => {
    const onError = (event: ErrorEvent) => {
      handleError(event.error ?? event.message, "window.error");
    };

    const onRejection = (event: PromiseRejectionEvent) => {
      handleError(event.reason, "unhandledrejection");
    };

    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);

    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, [handleError]);

  return <>{children}</>;
}
