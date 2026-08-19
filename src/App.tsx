import { lazy, useCallback, useEffect } from "react";
import { Route, Routes, useLocation } from "react-router-dom";
import { ResourceType, toPlural } from "@/lib/resource-registry";

import { ErrorBoundary } from "@/components/ui/error-boundary";
import { useToast } from "@/components/ui/use-toast";
import { Layout } from "@/components/layout/Layout";
import { ErrorProvider } from "@/contexts/error-context";
import { useAuthFlowEvents } from "@/hooks/useAuthFlowEvents";
import { AuthTerminal } from "@/components/terminal/AuthTerminal";
import { usePortForwardEvents } from "@/hooks/usePortForwardEvents";
import { usePortForwardAutoStart } from "@/hooks/usePortForwardAutoStart";
import { useAutoUpdater } from "@/hooks/useAutoUpdater";
import { usePortForwardStore } from "@/stores/portForwardStore";
import { useThemeStore } from "@/stores/themeStore";
import { setupFrontendLogger } from "@/lib/frontend-logger";
import { startWindowActivity } from "@/lib/window-activity";
import { logInfo, flushLogs } from "@/lib/logger";

// Lazy load all pages for code splitting
const ClusterOverview = lazy(() =>
  import("@/pages/ClusterOverview").then((m) => ({
    default: m.ClusterOverview,
  }))
);
const Workloads = lazy(() =>
  import("@/pages/Workloads").then((m) => ({ default: m.Workloads }))
);
const Network = lazy(() =>
  import("@/pages/Network").then((m) => ({ default: m.Network }))
);
const Storage = lazy(() =>
  import("@/pages/Storage").then((m) => ({ default: m.Storage }))
);
const Configuration = lazy(() =>
  import("@/pages/Configuration").then((m) => ({ default: m.Configuration }))
);
const NodeList = lazy(() =>
  import("@/components/resources/NodeList").then((m) => ({
    default: m.NodeList,
  }))
);
const NamespaceList = lazy(() =>
  import("@/components/resources/NamespaceList").then((m) => ({
    default: m.NamespaceList,
  }))
);
const Events = lazy(() =>
  import("@/pages/Events").then((m) => ({ default: m.Events }))
);
const Helm = lazy(() =>
  import("@/pages/Helm").then((m) => ({ default: m.Helm }))
);
const HelmDetail = lazy(() =>
  import("@/pages/HelmDetail").then((m) => ({ default: m.HelmDetail }))
);
const Settings = lazy(() =>
  import("@/pages/Settings").then((m) => ({ default: m.Settings }))
);
const PodDetail = lazy(() =>
  import("@/pages/PodDetail").then((m) => ({ default: m.PodDetail }))
);
const DeploymentDetail = lazy(() =>
  import("@/pages/DeploymentDetail").then((m) => ({
    default: m.DeploymentDetail,
  }))
);
const ReplicaSetDetail = lazy(() =>
  import("@/pages/ReplicaSetDetail").then((m) => ({
    default: m.ReplicaSetDetail,
  }))
);
const ServiceDetail = lazy(() =>
  import("@/pages/ServiceDetail").then((m) => ({ default: m.ServiceDetail }))
);
const NodeDetail = lazy(() =>
  import("@/pages/NodeDetail").then((m) => ({ default: m.NodeDetail }))
);
const IngressDetail = lazy(() =>
  import("@/pages/IngressDetail").then((m) => ({ default: m.IngressDetail }))
);
const GatewayDetail = lazy(() =>
  import("@/pages/GatewayDetail").then((m) => ({ default: m.GatewayDetail }))
);
const GatewayRouteDetail = lazy(() =>
  import("@/pages/GatewayRouteDetail").then((m) => ({
    default: m.GatewayRouteDetail,
  }))
);
const PersistentVolumeDetail = lazy(() =>
  import("@/pages/PersistentVolumeDetail").then((m) => ({
    default: m.PersistentVolumeDetail,
  }))
);
const PersistentVolumeClaimDetail = lazy(() =>
  import("@/pages/PersistentVolumeClaimDetail").then((m) => ({
    default: m.PersistentVolumeClaimDetail,
  }))
);
const StorageClassDetail = lazy(() =>
  import("@/pages/StorageClassDetail").then((m) => ({
    default: m.StorageClassDetail,
  }))
);
const EndpointsDetail = lazy(() =>
  import("@/pages/EndpointsDetail").then((m) => ({
    default: m.EndpointsDetail,
  }))
);
const StatefulSetDetail = lazy(() =>
  import("@/pages/StatefulSetDetail").then((m) => ({
    default: m.StatefulSetDetail,
  }))
);
const DaemonSetDetail = lazy(() =>
  import("@/pages/DaemonSetDetail").then((m) => ({
    default: m.DaemonSetDetail,
  }))
);
const JobDetail = lazy(() =>
  import("@/pages/JobDetail").then((m) => ({ default: m.JobDetail }))
);
const CronJobDetail = lazy(() =>
  import("@/pages/CronJobDetail").then((m) => ({ default: m.CronJobDetail }))
);
const Crds = lazy(() =>
  import("@/pages/Crds").then((m) => ({ default: m.Crds }))
);
const CrdDetail = lazy(() =>
  import("@/pages/CrdDetail").then((m) => ({ default: m.CrdDetail }))
);
const CustomResourceDetail = lazy(() =>
  import("@/pages/CustomResourceDetail").then((m) => ({
    default: m.CustomResourceDetail,
  }))
);
const ConfigMapDetail = lazy(() =>
  import("@/pages/ConfigMapDetail").then((m) => ({
    default: m.ConfigMapDetail,
  }))
);
const SecretDetail = lazy(() =>
  import("@/pages/SecretDetail").then((m) => ({ default: m.SecretDetail }))
);
const IntegrationsList = lazy(() =>
  import("@/pages/IntegrationsList").then((m) => ({
    default: m.IntegrationsList,
  }))
);
const IntegrationPage = lazy(() =>
  import("@/pages/IntegrationPage").then((m) => ({
    default: m.IntegrationPage,
  }))
);

export default function App() {
  const { theme } = useThemeStore();
  const location = useLocation();
  const { toast } = useToast();
  const refreshPortForwardConfigs = usePortForwardStore(
    (state) => state.refreshConfigs
  );
  const refreshPortForwardSessions = usePortForwardStore(
    (state) => state.refreshSessions
  );

  // Global event hooks (ErrorProvider now handles error toasts)
  const { authTerminalSession, closeAuthTerminal } = useAuthFlowEvents();
  usePortForwardEvents();
  usePortForwardAutoStart();
  // Initialize auto-updater
  useAutoUpdater();

  // Mounted here rather than in a component that can remount: every query in
  // the app polls against these three facts, and a second set of listeners
  // would double-count the reader's clicks.
  useEffect(() => startWindowActivity(), []);

  useEffect(() => {
    const cleanup = setupFrontendLogger();
    return () => {
      // Flush any pending logs before cleanup
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

  useEffect(() => {
    const root = window.document.documentElement;
    root.classList.remove("light", "dark");

    if (theme === "system") {
      const systemTheme = window.matchMedia("(prefers-color-scheme: dark)")
        .matches
        ? "dark"
        : "light";
      root.classList.add(systemTheme);
    } else {
      root.classList.add(theme);
    }
  }, [theme]);

  useEffect(() => {
    logInfo("Route change", {
      context: "router",
      data: { path: location.pathname },
    });
  }, [location.pathname]);

  const handleError = useCallback(
    (error: Error) => {
      toast({
        title: "Unexpected error",
        description: error.message || "Something went wrong while rendering.",
        variant: "destructive",
      });
    },
    [toast]
  );

  return (
    <ErrorProvider>
      <ErrorBoundary resetKey={location.pathname} onError={handleError}>
        <Routes>
          <Route path="/" element={<Layout />}>
            <Route index element={<ClusterOverview />} />
            <Route path="workloads/*" element={<Workloads />} />
            <Route path="network/*" element={<Network />} />
            <Route path="storage/*" element={<Storage />} />
            <Route path="configuration/*" element={<Configuration />} />
            <Route path={toPlural(ResourceType.Node)} element={<NodeList />} />
            <Route
              path={`${toPlural(ResourceType.Node)}/:name`}
              element={<NodeDetail />}
            />
            <Route
              path={toPlural(ResourceType.Namespace)}
              element={<NamespaceList />}
            />
            <Route path="events" element={<Events />} />
            <Route path="helm" element={<Helm />} />
            <Route
              path="helm/:source/:namespace/:name"
              element={<HelmDetail />}
            />
            {/* A splat, because each settings section is its own URL. */}
            <Route path="settings/*" element={<Settings />} />
            {/* One route for every vendor page: the shell resolves the slug
                through the integrations registry and never names a vendor.
                Which tab is open is a query parameter, so a scope tab parks
                and restores the whole screen. */}
            {/* The catalog first: the inventory of what this cluster has,
                which used to hide inside Settings. */}
            <Route path="integrations" element={<IntegrationsList />} />
            <Route path="integrations/:slug" element={<IntegrationPage />} />
            <Route
              path={`${toPlural(ResourceType.Pod)}/:namespace/:name`}
              element={<PodDetail />}
            />
            <Route
              path={`${toPlural(ResourceType.Deployment)}/:namespace/:name`}
              element={<DeploymentDetail />}
            />
            {/* A detail route and no list route: a ReplicaSet is somewhere
                you land, never somewhere you browse. */}
            <Route
              path={`${toPlural(ResourceType.ReplicaSet)}/:namespace/:name`}
              element={<ReplicaSetDetail />}
            />
            <Route
              path={`${toPlural(ResourceType.Service)}/:namespace/:name`}
              element={<ServiceDetail />}
            />
            <Route
              path={`${toPlural(ResourceType.Ingress)}/:namespace/:name`}
              element={<IngressDetail />}
            />
            <Route
              path={`${toPlural(ResourceType.Gateway)}/:namespace/:name`}
              element={<GatewayDetail />}
            />
            {[
              ResourceType.HTTPRoute,
              ResourceType.GRPCRoute,
              ResourceType.TLSRoute,
              ResourceType.TCPRoute,
              ResourceType.UDPRoute,
            ].map((kind) => (
              <Route
                key={kind}
                path={`${toPlural(kind)}/:namespace/:name`}
                element={<GatewayRouteDetail kind={kind} />}
              />
            ))}
            <Route
              path={`${toPlural(ResourceType.PersistentVolume)}/:name`}
              element={<PersistentVolumeDetail />}
            />
            <Route
              path={`${toPlural(ResourceType.PersistentVolumeClaim)}/:namespace/:name`}
              element={<PersistentVolumeClaimDetail />}
            />
            <Route
              path={`${toPlural(ResourceType.StorageClass)}/:name`}
              element={<StorageClassDetail />}
            />
            <Route
              path={`${toPlural(ResourceType.Endpoints)}/:namespace/:name`}
              element={<EndpointsDetail />}
            />
            <Route
              path={`${toPlural(ResourceType.StatefulSet)}/:namespace/:name`}
              element={<StatefulSetDetail />}
            />
            <Route
              path={`${toPlural(ResourceType.DaemonSet)}/:namespace/:name`}
              element={<DaemonSetDetail />}
            />
            <Route
              path={`${toPlural(ResourceType.Job)}/:namespace/:name`}
              element={<JobDetail />}
            />
            <Route
              path={`${toPlural(ResourceType.CronJob)}/:namespace/:name`}
              element={<CronJobDetail />}
            />
            <Route
              path={`${toPlural(ResourceType.ConfigMap)}/:namespace/:name`}
              element={<ConfigMapDetail />}
            />
            <Route
              path={`${toPlural(ResourceType.Secret)}/:namespace/:name`}
              element={<SecretDetail />}
            />
            {/* CRD Routes */}
            <Route
              path={toPlural(ResourceType.CustomResourceDefinition)}
              element={<Crds />}
            />
            <Route
              path={`${toPlural(ResourceType.CustomResourceDefinition)}/:name`}
              element={<CrdDetail />}
            />
            <Route
              path={`${toPlural(ResourceType.CustomResourceDefinition)}/:crdName/instances/:namespace/:name`}
              element={<CustomResourceDetail />}
            />
            <Route
              path={`${toPlural(ResourceType.CustomResourceDefinition)}/:crdName/instances/:name`}
              element={<CustomResourceDetail />}
            />
          </Route>
        </Routes>
        {/* Auth terminal modal - shown when interactive auth requires terminal input */}
        {authTerminalSession && (
          <AuthTerminal
            open={true}
            onClose={closeAuthTerminal}
            authSessionId={authTerminalSession.authSessionId}
            terminalSessionId={authTerminalSession.terminalSessionId}
            context={authTerminalSession.context}
            command={authTerminalSession.command}
          />
        )}
      </ErrorBoundary>
    </ErrorProvider>
  );
}
