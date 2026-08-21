import React, { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { open } from "@tauri-apps/plugin-shell";
import { useToast } from "@/components/ui/use-toast";
import { useT } from "@/i18n/useT";
import { ToastAction } from "@/components/ui/toast";
import { commands } from "@/lib/commands";

interface AuthUrlRequestedPayload {
  context: string;
  url: string;
  flow: string;
  session_id?: string | null;
  /// Where the provider is expected to send the browser back, when the flow
  /// has one. Shown while waiting: a provider that has not been told to allow
  /// it refuses immediately, and only the reader can go and add it.
  redirect_uri?: string | null;
}

interface AuthFlowCompletedPayload {
  session_id: string;
  context: string;
  success: boolean;
  message?: string | null;
}

interface AuthFlowCancelledPayload {
  session_id: string;
  context: string;
  message?: string | null;
}

interface AuthTerminalSessionCreatedPayload {
  auth_session_id: string;
  terminal_session_id: string;
  context: string;
  command: string;
}

interface AuthTerminalSession {
  authSessionId: string;
  terminalSessionId: string;
  context: string;
  command: string;
}

const AUTH_WINDOW_PREFIX = "auth-";

export function useAuthFlowEvents() {
  const { toast, dismiss } = useToast();
  const t = useT();
  const windowsRef = useRef<Record<string, WebviewWindow>>({});
  const activeSessionsRef = useRef<Set<string>>(new Set());
  const toastIdsRef = useRef<Record<string, string>>({});
  // Use refs for toast functions to avoid re-running effect when they change
  const toastRef = useRef(toast);
  const dismissRef = useRef(dismiss);
  // Same reason, and one more: listing `t` as a dependency would tear down
  // every listener on a language change, dropping any sign-in in flight.
  const tRef = useRef(t);

  // State for auth terminal modal
  const [authTerminalSession, setAuthTerminalSession] =
    useState<AuthTerminalSession | null>(null);

  // Keep refs up to date
  useEffect(() => {
    toastRef.current = toast;
    tRef.current = t;
    dismissRef.current = dismiss;
  }, [toast, dismiss, t]);

  useEffect(() => {
    let mounted = true;
    const unlistenFns: (() => void)[] = [];

    const dismissToast = (sessionId: string) => {
      const toastId = toastIdsRef.current[sessionId];
      if (toastId) {
        dismissRef.current(toastId);
        delete toastIdsRef.current[sessionId];
      }
    };

    const closeWindow = async (sessionId: string) => {
      // Remove from active sessions
      activeSessionsRef.current.delete(sessionId);
      // Dismiss auth toast
      dismissToast(sessionId);

      try {
        const existing = windowsRef.current[sessionId];
        if (existing) {
          try {
            await existing.destroy();
          } catch {
            try {
              await existing.close();
            } catch {
              // ignore - window may already be closed
            }
          }
          delete windowsRef.current[sessionId];
          return;
        }

        const label = `${AUTH_WINDOW_PREFIX}${sessionId}`;
        try {
          const found = await WebviewWindow.getByLabel(label);
          if (found) {
            try {
              await found.destroy();
            } catch {
              try {
                await found.close();
              } catch {
                // ignore
              }
            }
          }
        } catch {
          // ignore - window may not exist or already be closed
        }
      } catch {
        // ignore all errors during window cleanup
      }
    };

    const setupListeners = async () => {
      // Listener for auth URL requests
      const unlistenRequested = await listen<AuthUrlRequestedPayload>(
        "auth-url-requested",
        async (event) => {
          if (!mounted) return;

          console.log("Received auth-url-requested event:", event.payload);
          const payload = event.payload;
          const sessionId = payload.session_id;
          if (!sessionId) {
            console.warn("No session_id in auth-url-requested payload");
            return;
          }

          // Prevent duplicate handling of the same session
          if (activeSessionsRef.current.has(sessionId)) {
            console.log("Session already being handled:", sessionId);
            return;
          }
          activeSessionsRef.current.add(sessionId);

          await closeWindow(sessionId);
          // Re-add since closeWindow removes it
          activeSessionsRef.current.add(sessionId);

          // Small delay to ensure window is fully closed
          await new Promise((resolve) => setTimeout(resolve, 100));

          try {
            // External URLs should be opened in system browser
            // localhost:8000 is likely an auth callback server, open externally
            // Only truly internal URLs (127.0.0.1 with our callback port) should stay internal
            const isCallbackUrl =
              payload.url.includes("127.0.0.1") &&
              payload.url.includes("/callback");

            console.log(
              "Auth URL type:",
              isCallbackUrl ? "callback" : "external",
              payload.url
            );

            if (!isCallbackUrl) {
              // Open in system browser - this includes OAuth providers and localhost auth servers
              console.log("Opening auth URL in system browser:", payload.url);
              if (!mounted) return;
              try {
                await open(payload.url);
                console.log("Successfully opened URL in browser");
              } catch (openError) {
                console.error("Failed to open URL with shell.open:", openError);
                // Fallback: try window.open (won't work in Tauri, but worth trying)
                globalThis.open(payload.url, "_blank");
              }

              const { id: toastId } = toastRef.current({
                title: tRef.current("auth", "started"),
                description: [
                  tRef.current("auth", "startedIn", {
                    context: payload.context,
                  }),
                  payload.redirect_uri
                    ? tRef.current("auth", "waitingOn", {
                        uri: payload.redirect_uri,
                      })
                    : null,
                ]
                  .filter(Boolean)
                  .join(" "),
                // Auto-dismiss after 10 minutes — long enough for a
                // realistic browser-auth flow (password manager,
                // SSO redirect, MFA) but short enough that an
                // abandoned attempt doesn't accumulate. The toast
                // is also dismissed proactively on auth-flow-
                // completed / -cancelled events (see closeWindow),
                // so this is only a worst-case fallback.
                duration: 10 * 60 * 1000,
                action: React.createElement(
                  ToastAction,
                  {
                    altText: "Cancel authentication",
                    onClick: () => {
                      console.log("Cancelling auth session:", sessionId);
                      commands.cancelAuthSession(sessionId).catch((e) => {
                        console.error("Failed to cancel auth session:", e);
                      });
                    },
                  },
                  "Cancel"
                ),
              });
              toastIdsRef.current[sessionId] = toastId;
            } else {
              // For local callback URLs, use WebviewWindow
              const label = `${AUTH_WINDOW_PREFIX}${sessionId}`;
              const window = new WebviewWindow(label, {
                url: payload.url,
                title: tRef.current("auth", "windowTitle", {
                  context: payload.context,
                }),
                width: 960,
                height: 720,
                resizable: true,
                center: true,
                focus: true,
              });

              window.once("tauri://error", (e) => {
                console.error("Auth window error:", e);
                toastRef.current({
                  title: tRef.current("auth", "windowFailed"),
                  description: tRef.current("auth", "windowFailedBody"),
                  variant: "destructive",
                });
                commands.cancelAuthSession(sessionId).catch(() => {});
              });

              window
                .onCloseRequested(async () => {
                  await commands.cancelAuthSession(sessionId);
                })
                .catch(() => {
                  // ignore
                });

              windowsRef.current[sessionId] = window;
            }
          } catch (error) {
            console.error("Failed to open auth URL:", error);
            toastRef.current({
              title: tRef.current("auth", "failed"),
              description: tRef.current("auth", "couldNotOpen"),
              variant: "destructive",
            });
            await commands.cancelAuthSession(sessionId).catch(() => {});
          }
        }
      );
      unlistenFns.push(unlistenRequested);

      // Listener for auth flow completed
      const unlistenCompleted = await listen<AuthFlowCompletedPayload>(
        "auth-flow-completed",
        async (event) => {
          if (!mounted) return;

          const payload = event.payload;
          await closeWindow(payload.session_id);

          // Close auth terminal modal if this is the active session
          setAuthTerminalSession((current) =>
            current?.authSessionId === payload.session_id ? null : current
          );

          if (payload.success) {
            toastRef.current({
              title: tRef.current("auth", "complete"),
              description: tRef.current("auth", "completeFor", {
                context: payload.context,
              }),
            });
          } else {
            toastRef.current({
              title: tRef.current("auth", "failed"),
              description:
                payload.message ||
                tRef.current("auth", "failedFor", { context: payload.context }),
              variant: "destructive",
            });
          }
        }
      );
      unlistenFns.push(unlistenCompleted);

      // Listener for auth flow cancelled
      const unlistenCancelled = await listen<AuthFlowCancelledPayload>(
        "auth-flow-cancelled",
        async (event) => {
          if (!mounted) return;

          const payload = event.payload;
          await closeWindow(payload.session_id);

          // Close auth terminal modal if this is the active session
          setAuthTerminalSession((current) =>
            current?.authSessionId === payload.session_id ? null : current
          );

          toastRef.current({
            title: tRef.current("auth", "cancelled"),
            description:
              payload.message ||
              tRef.current("auth", "cancelledFor", {
                context: payload.context,
              }),
          });
        }
      );
      unlistenFns.push(unlistenCancelled);

      // Listener for auth terminal session created
      const unlistenTerminalCreated =
        await listen<AuthTerminalSessionCreatedPayload>(
          "auth-terminal-session-created",
          async (event) => {
            if (!mounted) return;

            console.log(
              "Received auth-terminal-session-created event:",
              event.payload
            );
            const payload = event.payload;
            setAuthTerminalSession({
              authSessionId: payload.auth_session_id,
              terminalSessionId: payload.terminal_session_id,
              context: payload.context,
              command: payload.command,
            });
          }
        );
      unlistenFns.push(unlistenTerminalCreated);
    };

    setupListeners();

    return () => {
      mounted = false;
      for (const unlisten of unlistenFns) {
        unlisten();
      }
    };
  }, []); // Empty dependencies - we use refs for toast/dismiss

  // Return auth terminal session data (not JSX!)
  return {
    authTerminalSession,
    closeAuthTerminal: () => setAuthTerminalSession(null),
  };
}
