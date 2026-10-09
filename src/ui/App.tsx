import { ShellVisibility } from "@/components/settings/ShellVisibility";
import { lazy, Suspense, useCallback, useEffect, type ReactNode } from "react";
import { Outlet, useRouterState } from "@tanstack/react-router";

import { ErrorBoundary } from "@/components/ui/error-boundary";
import { useToast } from "@/components/ui/use-toast";
import { ErrorProvider } from "@/contexts/error-context";
import { useAuthFlowEvents } from "@/hooks/useAuthFlowEvents";
import { useWatchForRenewals } from "@/hooks/useCredentialRenewal";
import { AuthTerminal } from "@/components/terminal/AuthTerminal";
import { usePortForwardEvents } from "@/hooks/usePortForwardEvents";
import { useTellMeWhen } from "@/hooks/useTellMeWhen";
import { useChangeJournal } from "@/hooks/useChangeJournal";
import { usePortForwardAutoStart } from "@/hooks/usePortForwardAutoStart";
import { useAutoUpdater } from "@/hooks/useAutoUpdater";
import { useDeepLinks } from "@/hooks/useDeepLinks";
import { useTerminalSessionSync } from "@/hooks/useTerminalSessionSync";
import { useKeptShells } from "@/hooks/useKeptShells";
import { usePortForwardStore } from "@/stores/portForwardStore";
import { useThemeStore } from "@/stores/themeStore";
import { applyTheme } from "@/lib/theme";
import { useClusterStore } from "@/stores/clusterStore";
import { setupFrontendLogger } from "@/lib/frontend-logger";
import { startWindowActivity } from "@/lib/window-activity";
import { keepNativeMenuForText, openMenusFromKeys } from "@/lib/native-menu";
import { stallWatch } from "@/lib/stall-watch";
import { logInfo, flushLogs } from "@/lib/logger";
import { markStartup, reportStartup } from "@/lib/startup";
import { useT } from "@/i18n/useT";

const SettingsOverlay = lazy(() =>
  import("@/components/settings/SettingsOverlay").then((m) => ({
    default: m.SettingsOverlay,
  }))
);

/**
 * Everything the window mounts once, around whatever route is open. It reads
 * no part of the location itself: the two things that do are leaves below,
 * so a navigation re-renders them and not the shell.
 */
export default function App() {
  const { theme } = useThemeStore();
  const refreshPortForwardConfigs = usePortForwardStore(
    (state) => state.refreshConfigs
  );
  const refreshPortForwardSessions = usePortForwardStore(
    (state) => state.refreshSessions
  );

  const { authTerminalSession, closeAuthTerminal } = useAuthFlowEvents();
  usePortForwardEvents();
  useWatchForRenewals();
  useTellMeWhen();
  useChangeJournal();
  usePortForwardAutoStart();
  useAutoUpdater();
  // At the root: a link can arrive at the front door or on a cluster the
  // kubeconfig lost, where no cluster shell is mounted to hear it.
  useDeepLinks();
  useTerminalSessionSync();
  useKeptShells();

  // Mounted here rather than in a component that can remount: every query in
  // the app polls against these three facts, and a second set of listeners
  // would double-count the reader's clicks.
  useEffect(() => startWindowActivity(), []);
  useEffect(() => keepNativeMenuForText(), []);
  useEffect(() => openMenusFromKeys(), []);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      markStartup("painted");
      reportStartup();
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  useEffect(() => stallWatch.start(), []);
  useEffect(() => {
    void useClusterStore.getState().loadContexts();
  }, []);

  useEffect(() => {
    const cleanup = setupFrontendLogger();
    return () => {
      flushLogs().catch(() => {});
      cleanup?.();
    };
  }, []);

  useEffect(() => {
    refreshPortForwardConfigs().catch((error) => {
      console.error("Failed to load port-forward configs:", error);
    });
    refreshPortForwardSessions().catch((error) => {
      console.error("Failed to load port-forward sessions:", error);
    });
  }, [refreshPortForwardConfigs, refreshPortForwardSessions]);

  useEffect(() => applyTheme(theme), [theme]);

  return (
    <ErrorProvider>
      <RouteErrorBoundary>
        <RouteChangeLog />
        {/* The layer covers the whole window and is opaque, so the page
            under it is polling at nobody. Where Settings used to be a
            route — which unmounted the page it replaced — it is now a
            sibling, and the routed shell stayed live behind it. This is
            the mechanism that exists for a subtree that is mounted and
            off screen. */}
        <ShellVisibility>
          <Outlet />
        </ShellVisibility>
        {/* Beside the routes, not under them: Settings has to open over a
            refused session, the front door and a tab mid-switch, the
            screens where something in it is usually the fix. */}
        <Suspense fallback={null}>
          <SettingsOverlay />
        </Suspense>
        {authTerminalSession && (
          <AuthTerminal
            open={true}
            onClose={closeAuthTerminal}
            authSessionId={authTerminalSession.authSessionId}
            terminalSessionId={authTerminalSession.terminalSessionId}
            context={authTerminalSession.context}
            command={authTerminalSession.command}
            replay={authTerminalSession.replay}
          />
        )}
      </RouteErrorBoundary>
    </ErrorProvider>
  );
}

const pathnameOf = (state: { location: { pathname: string } }) =>
  state.location.pathname;

function RouteErrorBoundary({ children }: { children: ReactNode }) {
  const t = useT();
  const { toast } = useToast();
  const pathname = useRouterState({ select: pathnameOf });
  const handleError = useCallback(
    (error: Error) => {
      toast({
        title: t("action", "unexpectedError"),
        description: error.message || t("action", "renderFailed"),
        variant: "destructive",
      });
    },
    [t, toast]
  );
  return (
    <ErrorBoundary resetKey={pathname} onError={handleError}>
      {children}
    </ErrorBoundary>
  );
}

function RouteChangeLog() {
  const pathname = useRouterState({ select: pathnameOf });
  useEffect(() => {
    logInfo("Route change", { context: "router", data: { path: pathname } });
  }, [pathname]);
  return null;
}
