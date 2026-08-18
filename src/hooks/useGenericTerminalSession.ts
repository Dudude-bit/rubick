import { useState, useRef, useCallback, useEffect } from "react";
import { commands } from "@/lib/commands";
import { listen } from "@tauri-apps/api/event";

export type SessionStatus =
  "idle" | "connecting" | "connected" | "closed" | "error";

interface UseGenericTerminalSessionProps {
  sessionId: string | null;
  onOutput?: (data: string) => void;
  onClose?: (status?: string | null) => void;
}

/**
 * Generic terminal session hook that works with any session ID.
 * Does not know about pods, processes, or any specific session type.
 */
export function useGenericTerminalSession({
  sessionId,
  onOutput,
  onClose,
}: UseGenericTerminalSessionProps) {
  const [status, setStatus] = useState<SessionStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const unlistenRef = useRef<(() => void)[]>([]);
  const statusRef = useRef<SessionStatus>("idle");
  // A component is mounted while its own effects run. Starting this at `false`
  // meant the effect below — declared first, so it runs first — could not tell
  // that it was, and skipped the `setStatus("connected")` that every keystroke
  // is gated on. It only bit when the session id was already known at mount,
  // which is what happens the first time the lazy xterm chunk loads slower
  // than `openPodShell` answers.
  const isMountedRef = useRef(true);
  const currentSessionIdRef = useRef<string | null>(null);

  // Use refs for callbacks to avoid re-running effect when they change
  const onOutputRef = useRef(onOutput);
  const onCloseRef = useRef(onClose);

  // Keep refs up to date
  useEffect(() => {
    onOutputRef.current = onOutput;
    onCloseRef.current = onClose;
  }, [onOutput, onClose]);

  // `send` and `resize` are called from xterm's own handlers rather than from
  // a render, so they read the status from a ref — which was declared and then
  // never written. Every keystroke typed into a pod shell was compared against
  // a permanent "idle" and dropped.
  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  const cleanupSession = useCallback(async () => {
    unlistenRef.current.forEach((u) => u());
    unlistenRef.current = [];

    const sid = currentSessionIdRef.current;
    if (sid) {
      currentSessionIdRef.current = null;
      try {
        await commands.closeTerminal(sid);
      } catch (err) {
        console.error("Failed to close terminal session:", err);
      }
      if (isMountedRef.current) {
        setStatus("closed");
      }
    } else {
      if (isMountedRef.current) {
        setStatus("idle");
      }
    }
  }, []);

  const send = useCallback(async (data: string) => {
    const sid = currentSessionIdRef.current;
    if (sid && statusRef.current === "connected") {
      try {
        await commands.terminalInput(sid, data);
      } catch (err) {
        console.error("Failed to send terminal input:", err);
      }
    }
  }, []);

  const resize = useCallback(async (cols: number, rows: number) => {
    const sid = currentSessionIdRef.current;
    if (sid && statusRef.current === "connected") {
      try {
        await commands.terminalResize(sid, cols, rows);
      } catch (err) {
        console.error("Failed to resize terminal:", err);
      }
    }
  }, []);

  // Setup listeners when sessionId changes
  useEffect(() => {
    let cleanupCalled = false;

    // Local cleanup function to avoid dependency issues
    const cleanup = () => {
      if (cleanupCalled) return;
      cleanupCalled = true;

      unlistenRef.current.forEach((u) => u());
      unlistenRef.current = [];

      const sid = currentSessionIdRef.current;
      if (sid) {
        currentSessionIdRef.current = null;
        commands.closeTerminal(sid).catch((err) => {
          console.error("Failed to close terminal session:", err);
        });
        if (isMountedRef.current) {
          setStatus("closed");
        }
      } else {
        if (isMountedRef.current) {
          setStatus("idle");
        }
      }
    };

    if (!sessionId) {
      cleanup();
      return;
    }

    currentSessionIdRef.current = sessionId;
    if (isMountedRef.current) {
      setStatus("connected");
      setError(null);
    }

    const setupListeners = async () => {
      // Check if cleanup was called during async setup
      if (cleanupCalled) return;

      try {
        // Listen for output
        const unlistenOutput = await listen<{
          session_id: string;
          data: string;
        }>("terminal-output", (event) => {
          if (event.payload.session_id === sessionId && onOutputRef.current) {
            onOutputRef.current(event.payload.data);
          }
        });
        if (cleanupCalled) {
          unlistenOutput();
          return;
        }
        unlistenRef.current.push(unlistenOutput);

        // Listen for close
        const unlistenClosed = await listen<{
          session_id: string;
          status?: string | null;
        }>("terminal-closed", (event) => {
          if (event.payload.session_id === sessionId) {
            unlistenRef.current.forEach((u) => u());
            unlistenRef.current = [];
            currentSessionIdRef.current = null;
            if (isMountedRef.current) {
              setStatus("closed");
            }
            if (onCloseRef.current) onCloseRef.current(event.payload.status);
          }
        });
        if (cleanupCalled) {
          unlistenClosed();
          return;
        }
        unlistenRef.current.push(unlistenClosed);

        // Both listeners are now installed. Tell the backend it's safe
        // to start reading from the adapter — without this signal the
        // I/O loop blocks (or, after the 60s safety timeout, fires into
        // the void). See `terminal::manager::create_session`.
        //
        // A failure HERE is benign: the listeners are installed and
        // will catch whatever events do fire. The most likely cause
        // is a race where the auth flow already finished (success or
        // error) before we got to subscribe, so the backend removed
        // the session and `mark_subscribed` returns "Session not
        // found". Surfacing that as "Failed to setup terminal
        // listeners" is misleading — the listeners are fine. Log and
        // move on.
        try {
          await commands.terminalSubscribed(sessionId);
        } catch (subscribeErr) {
          console.warn(
            "terminalSubscribed rejected (session likely closed already, listeners still installed):",
            subscribeErr
          );
        }
      } catch (err) {
        console.error("Failed to setup terminal listeners:", err);
        if (isMountedRef.current) {
          setStatus("error");
          setError("Failed to setup terminal listeners");
        }
      }
    };

    setupListeners();

    // Cleanup on sessionId change or unmount
    return cleanup;
  }, [sessionId]);

  // Track mount state
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  return {
    status,
    error,
    send,
    resize,
    disconnect: cleanupSession,
  };
}
